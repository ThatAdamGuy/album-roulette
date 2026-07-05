// page.js — runs in the MAIN world on music.youtube.com.
// Owns everything that needs page context: the InnerTube API (yt.config_,
// SAPISIDHASH auth) and starting playback. Talks to content.js (isolated
// world) via window.postMessage.

(() => {
  const ORIGIN = 'https://music.youtube.com';
  const AUTOPLAY_KEY = 'ytra_autoplay'; // sessionStorage: browseId to play after navigation

  const cfg = () => window.yt?.config_ || window.ytcfg?.data_;

  async function sapisidHash() {
    const m = document.cookie.match(/(?:^|; )(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!m) throw new Error('Not signed in to YouTube Music');
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(`${ts} ${m[1]} ${ORIGIN}`)
    );
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  async function browse(body, contToken) {
    const c = cfg();
    if (!c?.INNERTUBE_API_KEY) throw new Error('YouTube Music page config not found');
    let url = `/youtubei/v1/browse?key=${c.INNERTUBE_API_KEY}&prettyPrint=false`;
    if (contToken) {
      const t = encodeURIComponent(contToken);
      url += `&ctoken=${t}&continuation=${t}&type=next`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': await sapisidHash(),
        'X-Origin': ORIGIN,
        'X-Goog-AuthUser': String(c.SESSION_INDEX ?? '0'),
      },
      credentials: 'include',
      body: JSON.stringify({ context: c.INNERTUBE_CONTEXT, ...body }),
    });
    if (!res.ok) throw new Error(`YouTube Music API error ${res.status}`);
    return res.json();
  }

  // Walk an InnerTube response collecting album tiles and continuation tokens.
  function collect(node, out) {
    if (!node || typeof node !== 'object') return;
    if (node.musicTwoRowItemRenderer) {
      const it = node.musicTwoRowItemRenderer;
      const browseId = it.navigationEndpoint?.browseEndpoint?.browseId;
      const thumbs = it.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      if (browseId) {
        out.albums.push({
          title: it.title?.runs?.[0]?.text || '(untitled)',
          subtitle: (it.subtitle?.runs || []).map((r) => r.text).join(''),
          browseId,
          thumb: (thumbs.find((t) => t.width >= 120) || thumbs[thumbs.length - 1])?.url || '',
        });
      }
      return;
    }
    if (node.nextContinuationData?.continuation) out.conts.push(node.nextContinuationData.continuation);
    if (node.continuationCommand?.token) out.conts.push(node.continuationCommand.token);
    for (const k in node) collect(node[k], out);
  }

  async function fetchShelf(browseId, isUpload) {
    const albums = [];
    let json = await browse({ browseId });
    for (let page = 0; page < 100; page++) {
      const out = { albums: [], conts: [] };
      collect(json, out);
      albums.push(...out.albums);
      if (!out.conts.length) break;
      json = await browse({}, out.conts[0]);
    }
    return albums.map((a) => ({ ...a, upload: isUpload }));
  }

  async function fetchLibrary() {
    const regular = await fetchShelf('FEmusic_liked_albums', false);
    let uploads = [];
    try {
      uploads = await fetchShelf('FEmusic_library_privately_owned_releases', true);
    } catch (e) {
      // No uploads shelf (most users) — not an error.
    }
    return [...regular, ...uploads];
  }

  // ---- playback ----------------------------------------------------------

  function findPlayButton() {
    const scopes = document.querySelectorAll(
      'ytmusic-responsive-header-renderer, ytmusic-detail-header-renderer'
    );
    for (const scope of scopes) {
      // Playlist-style album pages (catalog albums) use a dedicated play
      // control; upload album pages use a labeled text button.
      const dedicated = scope.querySelector('ytmusic-play-button-renderer');
      if (dedicated) {
        return dedicated.querySelector('#play-button, button, [role="button"]') || dedicated;
      }
      for (const el of scope.querySelectorAll('yt-button-renderer, button')) {
        const label = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
        if (/\bplay\b/i.test(label) && !/playlist/i.test(label)) {
          return el.querySelector('button') || el;
        }
      }
    }
    return null;
  }

  const playerTrack = () =>
    document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || '';

  // On the album page: click Play until audio starts. Because every roll
  // pauses playback first, "video is playing" reliably means the new album
  // started (the old track can't still be running).
  function startPlayLoop() {
    const started = Date.now();
    let clicks = 0;
    const timer = setInterval(() => {
      const video = document.querySelector('video');
      if (video && !video.paused) {
        clearInterval(timer);
        sessionStorage.removeItem(AUTOPLAY_KEY);
        notify({ type: 'YTRA_PLAYING', track: playerTrack() });
        return;
      }
      const btn = findPlayButton();
      if (btn && clicks < 4) {
        btn.click();
        clicks++;
      }
      if (Date.now() - started > 20000) {
        clearInterval(timer);
        sessionStorage.removeItem(AUTOPLAY_KEY);
        notify({ type: 'YTRA_PLAY_TIMEOUT' });
      }
    }, 800);
  }

  // Full-reload path: if a roll caused a real page load (hard fallback, or a
  // browseEndpoint dispatch that YTM's router chose to full-navigate), the
  // fresh page.js instance picks up the flag on the album page and plays.
  // Catalog albums land on /playlist (redirected from /browse/MPREb…),
  // uploads stay on /browse/.
  function autoplayIfPending() {
    const browseId = sessionStorage.getItem(AUTOPLAY_KEY);
    if (!browseId) return;
    if (!/^\/(browse\/|playlist|watch)/.test(location.pathname)) return;
    sessionStorage.removeItem(AUTOPLAY_KEY);
    startPlayLoop();
  }

  function playAlbum(browseId) {
    // Pause first: YTM's beforeunload "Leave site?" prompt only arms while
    // music is actively playing, and the navigation below may end up being
    // a real page load.
    document.querySelector('video')?.pause();
    // If it IS a real load, this flag lets the fresh page.js instance finish
    // the job via autoplayIfPending. Cleared by startPlayLoop on success.
    sessionStorage.setItem(AUTOPLAY_KEY, browseId);
    const appEl = document.querySelector('ytmusic-app');
    if (!appEl) {
      location.href = `${ORIGIN}/browse/${encodeURIComponent(browseId)}`;
      return;
    }
    // SPA-navigate to the album page — the user sees cover + tracklist of
    // what they rolled — then click Play. YTM's router sometimes forces a
    // real load instead (e.g. crossing the uploads/catalog boundary); the
    // reload path above takes over in that case.
    const prevHref = location.href;
    appEl.dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true,
      composed: true,
      detail: { endpoint: { browseEndpoint: { browseId } } },
    }));
    const started = Date.now();
    const wait = setInterval(() => {
      if (location.href !== prevHref) {
        clearInterval(wait);
        startPlayLoop();
      } else if (Date.now() - started > 8000) {
        // Dispatch didn't move us (possibly already on this album's page):
        // hard navigation as last resort; the reload path finishes the job.
        clearInterval(wait);
        location.href = `${ORIGIN}/browse/${encodeURIComponent(browseId)}`;
      }
    }, 400);
  }

  // ---- bridge to content.js ---------------------------------------------

  const notify = (msg) => window.postMessage({ ns: 'ytra-page', ...msg }, ORIGIN);

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const msg = e.data;
    if (msg?.ns !== 'ytra-content') return;
    try {
      if (msg.cmd === 'FETCH_LIBRARY') {
        const albums = await fetchLibrary();
        notify({ type: 'YTRA_RESULT', id: msg.id, ok: true, albums });
      } else if (msg.cmd === 'PLAY_ALBUM') {
        notify({ type: 'YTRA_RESULT', id: msg.id, ok: true });
        playAlbum(msg.browseId);
      }
    } catch (err) {
      notify({ type: 'YTRA_RESULT', id: msg.id, ok: false, error: String(err.message || err) });
    }
  });

  autoplayIfPending();
})();
