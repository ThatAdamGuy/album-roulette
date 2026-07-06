// page.js — runs in the MAIN world on music.youtube.com.
// Owns everything that needs page context: the InnerTube API (yt.config_,
// SAPISIDHASH auth) and starting playback. Talks to content.js (isolated
// world) via window.postMessage.

(() => {
  const ORIGIN = 'https://music.youtube.com';
  const AUTOPLAY_KEY = 'ytra_autoplay'; // sessionStorage: browseId to play after navigation

  // MAIN-world scripts survive extension reloads until the tab itself is
  // refreshed, so reloading the extension during development stacks up
  // stale copies — each with its own album-end detector and PLAY_ALBUM
  // listener (=> double chimes / double rolls). Newest copy wins; older
  // generations detect they're superseded and go inert.
  const GEN = (window.__ytraGen = (window.__ytraGen || 0) + 1);
  const stale = () => window.__ytraGen !== GEN;

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

  // ---- album-end detection ------------------------------------------------
  // YTM's classic #movie_player element exposes getVideoData() reliably even
  // though getPlaylist() comes back empty (YTM manages album queues outside
  // that API) — verified live. We separately learn the album's last track's
  // videoId via one browse call, then poll for playback moving past it. This
  // is deliberately skip-tolerant: it keys off *which track is last*, not
  // elapsed time or a play-count, so fast-forwarding through tracks doesn't
  // miscount — it only fires once the last track's videoId is left behind.
  const getCurrentVideoId = () => {
    try {
      return document.querySelector('#movie_player')?.getVideoData?.()?.video_id || null;
    } catch (e) {
      return null;
    }
  };

  // Distinct non-radio videoIds sharing the album's own playlistId, in
  // encounter order — first is track 1, last is the album's last track.
  // Works the same for catalog (OLAK5uy_…) and upload (MLPRb_po_…) playlist
  // ids — verified live.
  async function resolveAlbumPlayback(browseId) {
    try {
      const json = await browse({ browseId });
      let albumPid = null;
      const ids = [];
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        const w = n.watchEndpoint;
        if (w?.videoId && w?.playlistId && !w.playlistId.startsWith('RDAM')) {
          if (!albumPid) albumPid = w.playlistId;
          if (w.playlistId === albumPid) ids.push(w.videoId);
        }
        for (const k in n) walk(n[k]);
      })(json);
      const distinct = [...new Set(ids)];
      if (!distinct.length) return null;
      return {
        playlistId: albumPid,
        firstVideoId: distinct[0],
        lastVideoId: distinct[distinct.length - 1],
        trackIds: distinct,
      };
    } catch (e) {
      return null;
    }
  }

  // Single module-level roll tracker; both the ended-listener and the
  // fallback poll consult it, and handledEnd makes the boundary one-shot.
  const PRE_END_LEAD_SECONDS = 0.5;
  let activeRoll = null; // { browseId, lastVideoId, trackIds:Set, handledEnd }
  let lastSeenVideoId = null;

  function armEndOfAlbumTracking(browseId, preresolved) {
    activeRoll = { browseId, lastVideoId: null, trackIds: null, handledEnd: false };
    const apply = (info) => {
      if (info && activeRoll && activeRoll.browseId === browseId) {
        activeRoll.lastVideoId = info.lastVideoId;
        activeRoll.trackIds = info.trackIds instanceof Set ? info.trackIds : new Set(info.trackIds || []);
      }
    };
    if (preresolved?.lastVideoId) apply(preresolved);
    else resolveAlbumPlayback(browseId).then(apply);
  }

  function fireAlbumEnded(reason, cur) {
    if (!activeRoll || activeRoll.handledEnd) return;
    activeRoll.handledEnd = true;
    ytraLog(`ALBUM_ENDED (${reason}) cur=${cur} last=${activeRoll.lastVideoId}`);
    notify({ type: 'YTRA_ALBUM_ENDED' });
  }

  function isActiveAlbumTrack(videoId) {
    return !!(videoId && activeRoll?.trackIds?.has(videoId));
  }

  // PRIMARY boundary signal (per review advice): the media 'ended' event on
  // the last track, with an IMMEDIATE pause inside the handler — intercepting
  // the boundary before YTM's Autoplay advances, instead of chasing it after.
  // Media events don't bubble but do reach document capture-phase listeners.
  // Attached both ways because this page's event plumbing has burned us
  // before (its scrollers fire no scroll events at all).
  function onMediaEnded(e) {
    if (stale()) return;
    if (e?.target?.tagName !== 'VIDEO') return;
    if (!activeRoll || activeRoll.handledEnd || !activeRoll.lastVideoId) return;
    const cur = getCurrentVideoId();
    if (cur === activeRoll.lastVideoId) {
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      try { e.target.pause(); } catch (err) { /* best effort */ }
      fireAlbumEnded('ended-event', cur);
    }
  }
  document.addEventListener('ended', onMediaEnded, true);
  setInterval(() => {
    if (stale()) return;
    const v = document.querySelector('video');
    if (v && v !== onMediaEnded._attached) {
      v.addEventListener('ended', onMediaEnded, true);
      onMediaEnded._attached = v;
    }
  }, 2000);

  // PRE-END boundary signal: catch the last track just before YTM's own
  // ended/autoplay pipeline can swap the bottom player to a suggested track.
  // The lead is deliberately tiny: enough to prevent the visible handoff,
  // but short enough not to feel like chopping the song's ending.
  setInterval(() => {
    if (stale()) return;
    if (!activeRoll || activeRoll.handledEnd || !activeRoll.lastVideoId) return;
    const video = document.querySelector('video');
    const cur = getCurrentVideoId();
    if (!video || video.paused || cur !== activeRoll.lastVideoId) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const rate = Math.max(video.playbackRate || 1, 0.25);
    const remaining = (video.duration - video.currentTime) / rate;
    if (remaining > 0 && remaining <= PRE_END_LEAD_SECONDS) {
      video.pause();
      fireAlbumEnded('pre-end', cur);
    }
  }, 100);

  // FALLBACK detection poll. The pre-end and ended-event
  // signals above are primary; this sweep covers states where they miss:
  //
  // 1. FINISHED NATURALLY (paused-at-end): YTM sometimes parks the player at
  //    queue end as paused with currentTime===duration and ended=FALSE
  //    (observed live on a real stuck player — checking .ended alone misses
  //    it). Works when YTM's own Autoplay is OFF and playback just stops.
  //
  // 2. TRANSITIONED OUT: playback was on the last track and moved to a video
  //    outside the album's own tracklist (Autoplay ON case — YTM started a
  //    suggestion before any catchable ended tick). The "outside the
  //    tracklist" check matters: without it, skipping *backward* from the
  //    last track to replay an earlier song would misfire as "album
  //    finished" (caught in testing before shipping).
  setInterval(() => {
    if (stale()) return;
    const cur = getCurrentVideoId();
    if (activeRoll && !activeRoll.handledEnd && activeRoll.lastVideoId) {
      const video = document.querySelector('video');
      const finishedNaturally = cur === activeRoll.lastVideoId && video &&
        (video.ended ||
          (video.duration > 0 && video.paused && video.currentTime >= video.duration - 0.4));
      const transitionedOut = lastSeenVideoId === activeRoll.lastVideoId &&
        cur && cur !== activeRoll.lastVideoId &&
        !(activeRoll.trackIds && activeRoll.trackIds.has(cur));
      if (finishedNaturally) fireAlbumEnded('finished-poll', cur);
      else if (transitionedOut) {
        video?.pause();
        fireAlbumEnded('transitioned-fast', cur);
      }
    }
    lastSeenVideoId = cur;
  }, 50);

  // YTM's tracklist container (ytmusic-section-list-renderer #contents) is
  // horizontally scrollable on narrower windows, and starting playback right
  // after navigation can leave it scrolled right — clipping the track-title
  // column off-screen so the page looks like it has a column-layout bug
  // (observed live: scrollLeft 572 on a 906px-wide container). Reset any
  // horizontally scrolled container after a roll; retries cover the layout
  // shifts that keep happening for a few seconds after playback starts.
  function resetTracklistScroll() {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth + 2) {
        el.scrollLeft = 0;
      }
    }
  }

  function scheduleTracklistScrollResets() {
    resetTracklistScroll();
    for (const ms of [800, 2000, 4500]) setTimeout(resetTracklistScroll, ms);
  }

  // Continuous guard, not just post-roll resets: the tracklist scroller
  // (ytmusic-section-list-renderer, overflow-x:auto by design) drifts
  // sideways from diagonal trackpad swipes while scrolling DOWN a tracklist,
  // sliding the title column off-screen — the recurring "columns are off"
  // report. Timed resets can't cover drift that happens while browsing.
  // Polling, not scroll events: this element's scrolls demonstrably don't
  // deliver scroll events to listeners (verified live — likely YTM plumbing),
  // so a cheap 600ms sweep clamps drift instead. Scoped: only section-lists
  // containing a track shelf — home/explore carousels keep their intentional
  // horizontal scrolling.
  setInterval(() => {
    if (stale()) return;
    for (const s of document.querySelectorAll('ytmusic-section-list-renderer')) {
      if (s.scrollLeft > 0 &&
          s.querySelector('ytmusic-playlist-shelf-renderer, ytmusic-shelf-renderer')) {
        s.scrollLeft = 0;
      }
    }
  }, 600);

  // On the album page: click Play until audio starts. Because every roll
  // pauses playback first, "video is playing" reliably means the new album
  // started (the old track can't still be running).
  // Breadcrumb log for field debugging: survives navigations (localStorage),
  // capped, readable via the page console (JSON.parse(localStorage.ytra_log)).
  function ytraLog(msg) {
    try {
      const log = JSON.parse(localStorage.getItem('ytra_log') || '[]');
      log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
      localStorage.setItem('ytra_log', JSON.stringify(log.slice(-60)));
    } catch (e) { /* quota/parse — never break playback over logging */ }
  }

  function fallbackToWatch(flag, reason) {
    if (!flag?.first || !flag?.pid) return false;
    sessionStorage.setItem(AUTOPLAY_KEY, JSON.stringify({ ...flag, mode: 'watch', t: Date.now() }));
    const url = `${ORIGIN}/watch?v=${encodeURIComponent(flag.first)}&list=${encodeURIComponent(flag.pid)}`;
    ytraLog(`${reason} → watch fallback ${flag.first} list=${String(flag.pid).slice(0, 14)}…`);
    location.replace(url);
    return true;
  }

  function startPlayLoop(flag = {}) {
    const started = Date.now();
    let clicks = 0;
    let timer;
    const tick = () => {
      const video = document.querySelector('video');
      if (video && !video.paused) {
        const cur = getCurrentVideoId();
        if (activeRoll?.trackIds?.size && !isActiveAlbumTrack(cur)) {
          video.pause();
          ytraLog(`suppressed carryover cur=${cur || 'unknown'} expected=${activeRoll.browseId}`);
          return;
        }
        clearInterval(timer);
        sessionStorage.removeItem(AUTOPLAY_KEY);
        scheduleTracklistScrollResets();
        ytraLog(`playing: ${playerTrack()} (${clicks} clicks)`);
        notify({ type: 'YTRA_PLAYING', track: playerTrack() });
        return;
      }
      const btn = findPlayButton();
      if (btn && clicks < 4) {
        btn.click();
        clicks++;
      }
      const playlistStalled = flag.mode === 'playlist' &&
        Date.now() - started > 5500 &&
        !document.querySelector('ytmusic-responsive-header-renderer, ytmusic-detail-header-renderer');
      const clickStalled = flag.mode === 'playlist' && Date.now() - started > 9000 && !clicks;
      if (playlistStalled || clickStalled) {
        clearInterval(timer);
        if (fallbackToWatch(flag, playlistStalled ? 'playlist blank/stalled' : 'playlist no-play-button')) return;
      }
      if (Date.now() - started > 20000) {
        clearInterval(timer);
        if (fallbackToWatch(flag, 'play timeout')) return;
        sessionStorage.removeItem(AUTOPLAY_KEY);
        ytraLog('play TIMEOUT after 20s');
        notify({ type: 'YTRA_PLAY_TIMEOUT' });
      }
    };
    timer = setInterval(tick, 350);
    tick();
  }

  // Watch-URL arrival fallback: playback autoplays natively — no Play button
  // to hunt. Normal resolved albums use playlist/album pages so the user sees
  // play counts and the tracklist.
  function startWatchVerifyLoop() {
    const started = Date.now();
    let nudges = 0;
    const timer = setInterval(() => {
      const video = document.querySelector('video');
      if (video && !video.paused && video.currentTime > 0) {
        const cur = getCurrentVideoId();
        if (activeRoll?.trackIds?.size && !isActiveAlbumTrack(cur)) {
          video.pause();
          ytraLog(`suppressed watch carryover cur=${cur || 'unknown'} expected=${activeRoll.browseId}`);
          return;
        }
        clearInterval(timer);
        sessionStorage.removeItem(AUTOPLAY_KEY);
        ytraLog(`playing (watch): ${playerTrack()} (${nudges} nudges)`);
        notify({ type: 'YTRA_PLAYING', track: playerTrack() });
        return;
      }
      if (Date.now() - started > 6000 && nudges < 2) {
        // Autoplay blocked? Nudge YTM's own play/pause control.
        document.querySelector('ytmusic-player-bar #play-pause-button')?.click();
        nudges++;
      }
      if (Date.now() - started > 20000) {
        clearInterval(timer);
        sessionStorage.removeItem(AUTOPLAY_KEY);
        ytraLog('watch-arrival TIMEOUT after 20s');
        notify({ type: 'YTRA_PLAY_TIMEOUT' });
      }
    }, 800);
  }

  // Arrival path on a fresh page load. The flag is NOT consumed on read (an
  // intermediate document must not eat it — that caused silent arrivals);
  // the verify/play loops remove it on success or timeout, and a 45s expiry
  // keeps a stale flag from ever firing later.
  function autoplayIfPending() {
    const raw = sessionStorage.getItem(AUTOPLAY_KEY);
    if (!raw) return;
    if (!/^\/(browse\/|playlist|watch)/.test(location.pathname)) return;
    let flag = { b: raw, t: 0 };
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.b) flag = parsed;
    } catch (e) { /* legacy plain-string flag */ }
    if (flag.t && Date.now() - flag.t > 45000) {
      sessionStorage.removeItem(AUTOPLAY_KEY);
      return;
    }
    ytraLog(`arrived ${location.pathname.slice(0, 20)} mode=${flag.mode || 'browse'}`);
    // Reuse the roll-time resolution when it rode along in the flag —
    // no second InnerTube call, and end-tracking arms instantly.
    armEndOfAlbumTracking(flag.b, flag.last
      ? { lastVideoId: flag.last, trackIds: flag.tracks || [] }
      : undefined);
    if (flag.mode === 'watch') startWatchVerifyLoop();
    else startPlayLoop(flag);
  }

  async function playAlbum(browseId) {
    // Resolve the album ONCE into {first, last, all track ids, album
    // playlistId}, then HARD-load the canonical album playlist page. That
    // keeps the album/tracklist view (including play counts) without the
    // /browse/MPREb redirect shell that caused blank pages. Resolution data
    // rides along in the flag so the arriving page arms end-detection with
    // zero extra API calls. /watch survives only as a fallback if the album
    // page can't be addressed by playlist id.
    //
    // Pause first: YTM's beforeunload "Leave site?" prompt only arms while
    // music is actively playing.
    document.querySelector('video')?.pause();
    const info = await resolveAlbumPlayback(browseId);
    if (info?.firstVideoId && info?.playlistId) {
      sessionStorage.setItem(AUTOPLAY_KEY, JSON.stringify({
        b: browseId, t: Date.now(), mode: 'playlist',
        first: info.firstVideoId, pid: info.playlistId,
        last: info.lastVideoId, tracks: info.trackIds,
      }));
      const url = `${ORIGIN}/playlist?list=${encodeURIComponent(info.playlistId)}`;
      ytraLog(`roll → playlist ${info.playlistId.slice(0, 14)}…`);
      location.href = url;
    } else {
      sessionStorage.setItem(AUTOPLAY_KEY, JSON.stringify({ b: browseId, t: Date.now(), mode: 'browse' }));
      ytraLog(`roll → browse fallback ${browseId.slice(0, 16)}`);
      location.href = `${ORIGIN}/browse/${encodeURIComponent(browseId)}`;
    }
  }

  // ---- bridge to content.js ---------------------------------------------

  const notify = (msg) => window.postMessage({ ns: 'ytra-page', ...msg }, ORIGIN);

  window.addEventListener('message', async (e) => {
    if (stale()) return;
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
