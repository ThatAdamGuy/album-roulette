// content.js — isolated world. Owns UI (header button + genre popover +
// toasts), the album cache, genre enrichment (iTunes Search API), and pick
// history in chrome.storage.local. Delegates InnerTube fetches and playback
// to page.js (MAIN world) via window.postMessage.

(() => {
  const ORIGIN = 'https://music.youtube.com';
  const CACHE_KEY = 'ytra_albums_v2';
  const GENRE_KEY = 'ytra_genres';
  const BUCKETS_KEY = 'ytra_buckets';
  const HISTORY_KEY = 'ytra_history';
  const PENDING_KEY = 'ytra_pending';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const HISTORY_MAX = 20;
  // iTunes pacing per research (July 2026): 3-4s spacing (~15-20/min) has a
  // decade-long track record of near-zero 403s; the limiter is per-IP,
  // burst-sensitive, and stochastic (distributed edge token buckets). On a
  // 403: defer the album and pause — never retry-loop, sustained hammering
  // is what earns long penalties. MusicBrainz fallback: hard 1 req/sec.
  const ENRICH_INTERVAL_MS = 4000;
  const ENRICH_BACKOFF_BASE_MS = 90000;
  const ENRICH_BACKOFF_MAX_MS = 720000;

  let busy = false;

  // ---- genre buckets -------------------------------------------------------
  // Raw iTunes primaryGenreName → coarse bucket. Raw strings are stored, so
  // re-bucketing is just editing this table.

  const BUCKET_LABELS = {
    jazz: 'Jazz',
    classical: 'Classical',
    soundtrack: 'Soundtracks & Musicals',
    vocal: 'Vocal & A cappella',
    newage: 'New Age',
    holiday: 'Holiday',
    poprock: 'Pop & Rock',
    other: 'Everything else',
  };
  const BUCKET_ORDER = ['jazz', 'classical', 'soundtrack', 'vocal', 'newage', 'holiday', 'poprock', 'other'];

  const GENRE_TO_BUCKET = {
    'jazz': 'jazz',
    'classical': 'classical',
    'opera': 'classical',
    'classical crossover': 'classical',
    'soundtrack': 'soundtrack',
    'soundtracks': 'soundtrack',
    'musicals': 'soundtrack',
    'anime': 'soundtrack',
    'original score': 'soundtrack',
    'video game': 'soundtrack',
    'tv soundtrack': 'soundtrack',
    'vocal': 'vocal',
    'vocal jazz': 'vocal',
    'choral': 'vocal',
    'new age': 'newage',
    'holiday': 'holiday',
    'christmas': 'holiday',
    'pop': 'poprock',
    'rock': 'poprock',
    'alternative': 'poprock',
    'indie pop': 'poprock',
    'indie rock': 'poprock',
    'singer/songwriter': 'poprock',
    'adult contemporary': 'poprock',
    'dance': 'poprock',
    'electronic': 'poprock',
    'r&b/soul': 'poprock',
    'hip-hop/rap': 'poprock',
    'country': 'poprock',
    'folk': 'poprock',
    'pop/rock': 'poprock',
    'k-pop': 'poprock',
    'j-pop': 'poprock',
    'latin': 'poprock',
    'reggae': 'poprock',
    'world': 'poprock',
  };

  // Substring tiers for raw genres missing from the exact table — handles
  // both iTunes vocabulary ("Christmas: Pop") and MusicBrainz tags
  // ("alternative rock", "hard bop"). Order matters: specific tiers first,
  // Pop & Rock is the broad catch-all. Tuned against a real 845-album
  // library distribution (July 2026).
  const GENRE_SUBSTRING_RULES = [
    ['soundtrack', ['soundtrack', 'score', 'musical', 'showtune', 'anime', 'video game', 'stage']],
    ['holiday', ['christmas', 'holiday', 'halloween']],
    ['jazz', ['jazz', 'swing', 'bebop', 'bop']],
    ['classical', ['classical', 'opera', 'baroque', 'symphon', 'chamber']],
    ['vocal', ['cappella', 'capella', 'choral', 'vocal', 'barbershop', 'standards']],
    ['newage', ['new age']],
    ['poprock', ['rock', 'pop', 'punk', 'folk', 'countr', 'dance', 'house', 'techno', 'trance',
      'electro', 'soul', 'funk', 'r&b', 'rap', 'hip', 'indie', 'metal', 'singer', 'christian',
      'gospel', 'worship', 'reggae', 'latin', 'world', 'celtic', 'blues', 'disco', 'grunge',
      'americana', 'tropical', 'contra', 'easy listening', 'adult contemporary']],
  ];

  // undefined = not yet looked up (in no bucket); null = looked up, no match.
  function bucketOf(rawGenre) {
    if (rawGenre === undefined) return undefined;
    if (!rawGenre) return 'other';
    const g = rawGenre.toLowerCase();
    if (GENRE_TO_BUCKET[g]) return GENRE_TO_BUCKET[g];
    for (const [bucket, subs] of GENRE_SUBSTRING_RULES) {
      if (subs.some((s) => g.includes(s))) return bucket;
    }
    return 'other';
  }

  // ---- bridge to page.js -------------------------------------------------

  let nextId = 1;
  const pending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (msg?.ns !== 'ytra-page') return;
    if (msg.type === 'YTRA_RESULT' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? resolve(msg) : reject(new Error(msg.error));
    } else if (msg.type === 'YTRA_PLAYING') {
      rollDone();
    } else if (msg.type === 'YTRA_PLAY_TIMEOUT') {
      rollDone();
      toast('Album loaded — press ▶ to start it', 6000);
    }
  });

  function callPage(cmd, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.postMessage({ ns: 'ytra-content', cmd, id, ...extra }, ORIGIN);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('YouTube Music did not respond'));
        }
      }, 120000);
    });
  }

  // ---- album cache ---------------------------------------------------------

  async function getAlbums(forceRefresh) {
    if (!forceRefresh) {
      const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.albums.length) {
        return cached.albums;
      }
    }
    toast('Reading your album library…');
    const { albums } = await callPage('FETCH_LIBRARY');
    if (!albums.length) throw new Error('No albums found in your library');
    await chrome.storage.local.set({ [CACHE_KEY]: { fetchedAt: Date.now(), albums } });
    startEnrichment(); // fresh library — tag whatever's new (no-op if already running)
    return albums;
  }

  async function getGenres() {
    const { [GENRE_KEY]: genres = {} } = await chrome.storage.local.get(GENRE_KEY);
    return genres;
  }

  // ---- random pick ---------------------------------------------------------

  async function pickFrom(pool) {
    const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
    const fresh = pool.filter((a) => !history.includes(a.browseId));
    const usable = fresh.length ? fresh : pool; // pool smaller than history window
    const pick = usable[Math.floor(Math.random() * usable.length)];
    await recordPick(pick);
    return pick;
  }

  async function recordPick(pick) {
    const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
    await chrome.storage.local.set({
      [HISTORY_KEY]: [pick.browseId, ...history.filter((b) => b !== pick.browseId)].slice(0, HISTORY_MAX),
    });
  }

  // Seasonal guard: full-random 🎲 skips holiday albums out of season (the
  // Holiday chip and Semi-🎲 still offer them year-round — those are explicit
  // choices). Gated by RAW genre so halloween albums get October instead of
  // the Christmas window. Cultural note: this only ever filters what the
  // genre databases label Holiday/Christmas/Halloween — in practice Western
  // Christmas music; festive albums from other traditions carry ordinary
  // genres and are never auto-benched.
  function holidayInSeason(rawGenre) {
    const now = new Date();
    const m = now.getMonth(); // 0 = January
    if (/halloween/i.test(rawGenre || '')) return m === 9;
    return (m === 10 && now.getDate() >= 15) || m === 11 || (m === 0 && now.getDate() <= 5);
  }

  async function playRandomAlbum(bucket) {
    if (busy) return;
    busy = true;
    setButtonSpin(true);
    closePopover();
    try {
      const albums = await getAlbums(false);
      const genres = await getGenres();
      let pool;
      if (bucket) {
        pool = albums.filter((a) => bucketOf(genres[a.browseId]) === bucket);
        if (!pool.length) throw new Error(`No ${BUCKET_LABELS[bucket] || bucket} albums tagged yet`);
      } else {
        pool = albums.filter((a) => {
          const raw = genres[a.browseId];
          return bucketOf(raw) !== 'holiday' || holidayInSeason(raw);
        });
        if (!pool.length) pool = albums; // all-holiday library — so be it
      }
      const pick = await pickFrom(pool);
      await playPick(pick);
    } catch (err) {
      toast(`Album Roulette: ${err.message}`, 6000);
      rollDone();
    }
  }

  async function playPick(pick) {
    toast(`🎲 ${pick.title}`, 5000);
    await callPage('PLAY_ALBUM', { browseId: pick.browseId });
    clearTimeout(rollSafetyTimer);
    rollSafetyTimer = setTimeout(rollDone, 30000);
  }

  let rollSafetyTimer;

  function rollDone() {
    busy = false;
    setButtonSpin(false);
    clearTimeout(rollSafetyTimer);
  }

  // ---- genre enrichment ----------------------------------------------------
  // Trickles through the library tagging albums via the iTunes Search API
  // (keyless, CORS-open). One tab at a time via the Web Locks API; progress
  // persists in chrome.storage, so it resumes anywhere it stopped.

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function albumArtist(album) {
    const parts = (album.subtitle || '').split(' • ');
    return parts[1] && !/^\d{4}$/.test(parts[1]) ? parts[1] : '';
  }

  // Fetch via the background worker: host-permission fetches are CORS-exempt
  // (iTunes' ACAO header is unreliable from page/content contexts).
  function bgFetchJson(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'YTRA_FETCH_JSON', url }, (res) => {
        resolve(chrome.runtime.lastError ? { status: 0 } : (res || { status: 0 }));
      });
    });
  }

  function cleanTitle(album) {
    return album.title.replace(/\s*[\(\[][^)\]]*[\)\]]/g, '').trim();
  }

  function primaryArtist(album) {
    return albumArtist(album).split(',')[0].split('&')[0].trim();
  }

  function titleMatches(candidate, tNorm) {
    const c = normalize(candidate || '');
    if (!c || !tNorm) return false;
    return c.includes(tNorm) || tNorm.includes(c) ||
      c.split(' ').filter((w) => tNorm.includes(w)).length >= Math.ceil(c.split(' ').length * 0.6);
  }

  // Resolves to a genre string, null (no match), or undefined (rate-limited /
  // transient error — caller should defer this album and back off).
  async function lookupGenre(album) {
    const clean = cleanTitle(album);
    const artist = primaryArtist(album);
    const term = encodeURIComponent(`${artist ? artist + ' ' : ''}${clean}`.slice(0, 120));
    const res = await bgFetchJson(
      `https://itunes.apple.com/search?term=${term}&entity=album&limit=3&country=US`);
    if (res.status === 403 || res.status === 429 || res.status === 0) return undefined;
    if (res.status !== 200 || !res.json) return null;
    const tNorm = normalize(clean);
    const hit = (res.json.results || []).find((r) => titleMatches(r.collectionName, tNorm));
    return hit?.primaryGenreName || null;
  }

  // MusicBrainz fallback (CC0 data, CORS-open, ToS-compatible with one-time
  // tagger lookups; hard limit 1 req/sec — callers must space calls).
  // Search returns community tags inline, so one request suffices.
  async function lookupGenreMB(album) {
    const clean = cleanTitle(album).replace(/"/g, '');
    const artist = primaryArtist(album).replace(/"/g, '');
    // Plain-text query, not quoted field syntax: strict phrase queries whiff
    // on slight title variants (measured 2% match on uploads); the
    // titleMatches() filter below guards precision instead.
    const q = artist ? `${clean} ${artist}` : clean;
    const res = await bgFetchJson(
      `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=5`);
    if (res.status === 503 || res.status === 0) return undefined;
    if (res.status !== 200 || !res.json) return null;
    const tNorm = normalize(clean);
    const hit = (res.json['release-groups'] || []).find((rg) => titleMatches(rg.title, tNorm));
    if (!hit) return null;
    const tags = [...(hit.genres || []), ...(hit.tags || [])]
      .sort((a, b) => (b.count || 0) - (a.count || 0));
    return tags[0]?.name || null;
  }

  async function updateBucketCounts() {
    const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
    const genres = await getGenres();
    const counts = {};
    let tagged = 0;
    for (const a of cached?.albums || []) {
      const b = bucketOf(genres[a.browseId]);
      if (b) {
        counts[b] = (counts[b] || 0) + 1;
        tagged++;
      }
    }
    await chrome.storage.local.set({
      [BUCKETS_KEY]: {
        counts, labels: BUCKET_LABELS, order: BUCKET_ORDER,
        tagged, total: (cached?.albums || []).length,
      },
    });
    // background.js watches this key and refreshes the toolbar badge + menus.
  }

  async function enrichPump() {
    await updateBucketCounts(); // badge + menus reflect reality within seconds of load
    let sinceCountUpdate = 0;
    let backoffLevel = 0;
    const deferred = new Set(); // albums that hit a rate limit — retried in a later pass
    let passes = 0;
    for (;;) {
      const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
      if (!cached?.albums?.length) return; // nothing to do until a first roll caches the library
      const genres = await getGenres();
      let next = cached.albums.find((a) => genres[a.browseId] === undefined && !deferred.has(a.browseId));
      if (!next && deferred.size && passes < 3) {
        deferred.clear(); // give rate-limited albums another pass
        passes++;
        continue;
      }
      if (!next) {
        await updateBucketCounts();
        refreshPopoverIfOpen();
        return;
      }
      let g = await lookupGenre(next);
      if (g === undefined) {
        // Rate-limited: defer this album, go quiet (jittered, escalating),
        // then move on to others rather than hammering the same request.
        deferred.add(next.browseId);
        backoffLevel = Math.min(backoffLevel + 1, 4);
        const nap = Math.min(ENRICH_BACKOFF_BASE_MS * 2 ** (backoffLevel - 1), ENRICH_BACKOFF_MAX_MS);
        await sleep(nap * (1 + Math.random() * 0.4));
        continue;
      }
      backoffLevel = 0;
      if (g === null) {
        // iTunes had no match — try MusicBrainz (respect its 1 req/sec).
        await sleep(1500);
        const mb = await lookupGenreMB(next);
        if (mb !== undefined) g = mb;
      }
      genres[next.browseId] = g;
      await chrome.storage.local.set({ [GENRE_KEY]: genres });
      if (++sinceCountUpdate >= 15) {
        sinceCountUpdate = 0;
        await updateBucketCounts();
        refreshPopoverIfOpen();
      }
      await sleep(ENRICH_INTERVAL_MS);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function startEnrichment() {
    if (navigator.locks?.request) {
      navigator.locks.request('ytra_enrich', { ifAvailable: true }, async (lock) => {
        if (lock) await enrichPump();
      }).catch(() => {});
    } else {
      enrichPump();
    }
  }

  // ---- UI: header button + chevron -----------------------------------------

  let button;

  function setButtonSpin(on) {
    button?.classList.toggle('ytra-spin', on);
  }

  function toast(text, ms = 3000) {
    let el = document.getElementById('ytra-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ytra-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('ytra-show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('ytra-show'), ms);
  }

  function injectButton() {
    if (document.getElementById('ytra-button')) return true;
    const bar =
      document.querySelector('ytmusic-nav-bar div.right-content') ||
      document.querySelector('ytmusic-nav-bar');
    if (!bar) return false;

    const wrap = document.createElement('div');
    wrap.id = 'ytra-wrap';

    button = document.createElement('button');
    button.id = 'ytra-button';
    button.title = 'Play a random album (right-click for genres)';
    button.textContent = '🎲';
    button.addEventListener('click', () => playRandomAlbum(null));
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      togglePopover();
    });

    const chevron = document.createElement('button');
    chevron.id = 'ytra-chevron';
    chevron.title = 'Pick by genre';
    chevron.textContent = '▾';
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover();
    });

    wrap.append(button, chevron);
    bar.prepend(wrap);
    return true;
  }

  const injectTimer = setInterval(() => {
    if (injectButton()) clearInterval(injectTimer);
  }, 1000);
  setTimeout(() => clearInterval(injectTimer), 30000);

  // ---- UI: genre popover -----------------------------------------------------

  let popover;

  function ensurePopover() {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.id = 'ytra-popover';
    document.body.appendChild(popover);
    document.addEventListener('click', (e) => {
      if (popover.classList.contains('ytra-open') &&
          !popover.contains(e.target) &&
          !document.getElementById('ytra-wrap')?.contains(e.target)) {
        closePopover();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePopover();
    });
    return popover;
  }

  function togglePopover() {
    ensurePopover();
    if (popover.classList.contains('ytra-open')) closePopover();
    else openPopover();
  }

  function closePopover() {
    popover?.classList.remove('ytra-open');
  }

  async function openPopover() {
    ensurePopover();
    positionPopover();
    popover.classList.add('ytra-open');
    await renderMainView();
  }

  function positionPopover() {
    const wrap = document.getElementById('ytra-wrap');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    popover.style.top = `${r.bottom + 8}px`;
    popover.style.right = `${Math.max(8, window.innerWidth - r.right - 8)}px`;
  }

  function refreshPopoverIfOpen() {
    if (popover?.classList.contains('ytra-open') && popover.dataset.view === 'main') {
      renderMainView();
    }
  }

  // music.youtube.com enforces Trusted Types (innerHTML throws, even for
  // content scripts), so all popover content is built with DOM APIs.
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  async function renderMainView() {
    popover.dataset.view = 'main';
    const albums = await getAlbums(false).catch(() => []);
    const genres = await getGenres();
    const counts = {};
    let tagged = 0;
    for (const a of albums) {
      const b = bucketOf(genres[a.browseId]);
      if (b !== undefined) {
        tagged++;
        counts[b] = (counts[b] || 0) + 1;
      }
    }
    const chips = BUCKET_ORDER
      .filter((b) => counts[b])
      .map((b) => el('button', {
        class: 'ytra-chip',
        onclick: () => playRandomAlbum(b),
        ...(b === 'other'
          ? { title: 'Albums without a confident genre match — still included in full-random rolls' }
          : {}),
      },
        document.createTextNode(BUCKET_LABELS[b] + ' '),
        el('span', { text: String(counts[b]) })));
    popover.replaceChildren(
      el('div', { class: 'ytra-pop-title' },
        document.createTextNode('Album Roulette'),
        el('button', {
          class: 'ytra-redeal', text: '?',
          title: 'How Album Roulette works',
          onclick: () => chrome.runtime.sendMessage({ type: 'YTRA_OPEN_HELP' }),
        }),
        el('button', {
          class: 'ytra-back', text: '↻',
          title: 'Re-scan your library now (picks up newly added albums)',
          onclick: async () => {
            try {
              await getAlbums(true);
              startEnrichment();
              toast('Library refreshed');
            } catch (err) {
              toast(`Album Roulette: ${err.message}`, 6000);
            }
            renderMainView();
          },
        })),
      ...(tagged < albums.length
        ? [el('div', {
            class: 'ytra-progress ytra-progress-top',
            title: 'The free genre services limit lookup speed, so this one-time indexing takes a while. Everything else works right away.',
            text: `Tagging genres… ${tagged}/${albums.length} · fills in over an hour or so`,
          })]
        : []),
      el('button', { class: 'ytra-semi', text: 'Semi-🎲  Deal me 6', onclick: () => renderDealView() }),
      el('div', { class: 'ytra-chips' },
        ...(chips.length ? chips
          : [el('div', { class: 'ytra-progress', text: 'No genres tagged yet — check back in a few minutes!' })]))
    );
  }

  async function renderDealView() {
    popover.dataset.view = 'deal';
    const albums = await getAlbums(false).catch(() => []);
    const genres = await getGenres();
    const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);

    // Group albums by bucket, then deal from as many different buckets as we can.
    const byBucket = {};
    for (const a of albums) {
      const b = bucketOf(genres[a.browseId]);
      if (b === undefined) continue;
      (byBucket[b] = byBucket[b] || []).push(a);
    }
    const bucketsAvail = Object.keys(byBucket).sort(() => Math.random() - 0.5);
    const dealt = [];
    const used = new Set();
    for (const b of bucketsAvail) {
      if (dealt.length >= 6) break;
      const pool = byBucket[b].filter((a) => !used.has(a.browseId) && !history.includes(a.browseId));
      const usable = pool.length ? pool : byBucket[b].filter((a) => !used.has(a.browseId));
      if (!usable.length) continue;
      const pick = usable[Math.floor(Math.random() * usable.length)];
      used.add(pick.browseId);
      dealt.push({ ...pick, bucket: b });
    }
    // Fewer buckets than 6? Fill out the hand from everything tagged.
    const allTagged = Object.values(byBucket).flat();
    while (dealt.length < 6 && used.size < allTagged.length) {
      const pool = allTagged.filter((a) => !used.has(a.browseId));
      const pick = pool[Math.floor(Math.random() * pool.length)];
      used.add(pick.browseId);
      dealt.push({ ...pick, bucket: bucketOf(genres[pick.browseId]) });
    }

    const playDealt = async (pick) => {
      if (busy) return;
      busy = true;
      setButtonSpin(true);
      closePopover();
      try {
        await recordPick(pick);
        await playPick(pick);
      } catch (err) {
        toast(`Album Roulette: ${err.message}`, 6000);
        rollDone();
      }
    };

    const cards = dealt.map((a) =>
      el('button', {
        class: 'ytra-card',
        title: albumArtist(a) ? `${a.title} — ${albumArtist(a)}` : a.title,
        onclick: () => playDealt(a),
      },
        el('img', { src: a.thumb || '', alt: '' }),
        el('div', { class: 'ytra-card-genre', text: BUCKET_LABELS[a.bucket] || '' }),
        el('div', { class: 'ytra-card-title', text: a.title })));
    popover.replaceChildren(
      el('div', { class: 'ytra-pop-title' },
        el('button', { class: 'ytra-back', text: '←', onclick: () => renderMainView() }),
        document.createTextNode('Semi-🎲'),
        el('button', { class: 'ytra-redeal', text: '↻ Deal again', onclick: () => renderDealView() })),
      el('div', { class: 'ytra-grid' },
        ...(cards.length ? cards
          : [el('div', { class: 'ytra-progress', text: 'Nothing tagged yet — try again in a minute.' })]))
    );
  }

  // ---- triggers from the background worker ----------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'RANDOM_ALBUM') playRandomAlbum(msg.genre || null);
  });

  // Toolbar icon / context menu was used from a non-YTM tab: background
  // opened this tab and left a flag so we start rolling as soon as we load.
  chrome.storage.local.get(PENDING_KEY).then(({ [PENDING_KEY]: pendingFlag }) => {
    const ts = typeof pendingFlag === 'object' ? pendingFlag?.ts : pendingFlag;
    if (ts && Date.now() - ts < 30000) {
      chrome.storage.local.remove(PENDING_KEY);
      playRandomAlbum(typeof pendingFlag === 'object' ? pendingFlag.genre || null : null);
    }
  });

  // Kick off enrichment a little after load so it never competes with the page.
  setTimeout(startEnrichment, 8000);

  chrome.storage.local.remove('ytra_albums'); // drop obsolete v1 cache (no thumbnails)
})();
