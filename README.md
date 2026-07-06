# Album Roulette for YouTube Music 🎲

One click plays a **random album from your YouTube Music library, start to finish** — the feature no streaming service has ever shipped.

## How it works

- A 🎲 button appears in the YouTube Music header (and the extension's toolbar icon does the same thing from any tab).
- Click it: the extension reads your library's album list — including **uploaded albums** — through YouTube Music's own internal API, using your existing signed-in session. Nothing leaves your browser; there are no accounts, keys, or servers.
- It picks an album at random (avoiding your last 20 picks), navigates to it, and presses Play. Track 1, in order, no shuffle.
- **Genres**: the ▾ next to the die (or right-click the die) opens the genre picker — chips like "Jazz · 74" play a random album within that genre, and **Semi-🎲 "Deal me 6"** shows six covers from six different genres to choose from. Genres come from the keyless iTunes Search API, tagged quietly in the background (~20 lookups/min; a big library takes under an hour, once, and is cached forever). The extension's toolbar icon also gets a right-click genre menu.
- **Keep rolling 🔁**: an opt-in toggle in the popover. When the album you rolled finishes, whatever's playing gets paused, a short chime plays after a beat of silence (so it doesn't get swallowed by the songs on either side of it), and — if left on — another random album (same genre, if you picked one) starts after another beat. Off by default; doesn't touch YouTube Music's own Autoplay setting (deliberately — see below).

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open [music.youtube.com](https://music.youtube.com) (signed in) and click the 🎲

## Architecture (no build step, vanilla JS)

- `manifest.json` — MV3. Permissions: `storage`, `contextMenus`.
- `page.js` — MAIN-world content script. Talks to the InnerTube API (`FEmusic_liked_albums` + `FEmusic_library_privately_owned_releases` shelves, with continuation paging) authenticated via SAPISIDHASH computed from the page's own cookies. Playback: resolve the album once into {first track, last track, all track ids, album playlistId}, then **hard-load `/watch?v=<first>&list=<playlistId>`** — YTM autoplays watch URLs natively, so there's no Play button to hunt and no redirect document. (Deliberately not SPA: `yt-navigate` into playlist pages renders broken widths — the "columns are off" bug; and not `/browse/MPREb…` hard loads: those bounce through a throwaway redirect shell — the blank pages.) Resolution data rides along in the sessionStorage flag, so the arriving page arms album-end detection with zero extra API calls; `/browse/` + click-Play survives as fallback. Album-end detection: media `ended` event first (with an immediate pause inside the handler, so YTM Autoplay never gets to advance), 1s state poll as fallback (YTM sometimes parks at queue end as paused-with-ended=false). A 600ms polling clamp also guards the tracklist against horizontal trackpad-drift (that element fires no scroll events, so polling is the only guard that works). Breadcrumb log in localStorage `ytra_log` for field debugging.
  - **Album-end detection**: after a roll, one extra browse call learns the album's full set of track videoIds (filtered by matching playlistId, radio/shuffle `RDAM…` variants excluded) and its last one. A 1s poll reads YTM's own `#movie_player.getVideoData().video_id` and fires `YTRA_ALBUM_ENDED` only when playback was on the last track *and* the new video isn't in the album's own tracklist at all — the second half of that check matters: keying off "not equal to the last track" alone misfires when a user skips *backward* from the last track to replay an earlier song (caught in testing, fixed before shipping). Deliberately 1s-grained and skip-tolerant: it keys off which track is last, not elapsed play time.
- `content.js` — isolated-world content script. Header 🎲+▾ buttons, genre popover (chips + Semi-🎲 deal grid + Keep Rolling toggle), toasts, album cache (`chrome.storage.local` `ytra_albums_v2`, 24h TTL, includes thumbnails), pick history, and the genre enrichment pump: iTunes Search API lookups (raw `primaryGenreName` stored permanently under `ytra_genres`, keyed by browseId), throttled to the API's ~20/min limit, single-tab via the Web Locks API, resumable. Raw genre → display bucket mapping lives in one table (`GENRE_TO_BUCKET`) so re-bucketing never requires re-fetching. On `YTRA_ALBUM_ENDED`: plays a synthesized four-note chime (Web Audio API — no bundled file, no licensing question) and, if Keep Rolling is on, rolls another album (same genre bucket as the one that just finished, if any). Bridges to `page.js` via `window.postMessage`.
- `background.js` — service worker; routes toolbar clicks, keyboard shortcut, and the toolbar-icon context menu (per-genre rolls, rebuilt from `ytra_buckets` counts) to a YTM tab, preferring the audible one; opens YTM if none exists. Also proxies genre-lookup fetches (CORS-exempt via host permissions) and drives the tagging-progress toolbar badge.

## Genre data sources (all keyless, all from the user's own IP)

1. **iTunes Search API** — primary. Paced at 4s/request (the limiter is per-IP, burst-sensitive, and stochastic; 403 = defer album + escalating jittered pause, never retry-loop). Fetched from the background worker (host permission) because iTunes' CORS header is unreliable.
2. **MusicBrainz** — fallback for albums iTunes can't match. One search request returns community tags inline; hard 1 req/sec limit respected.
3. Future: Chrome built-in AI (Gemini Nano, Chrome 138+, hardware-gated) as an opportunistic offline tier; possibly a bundled MusicBrainz-derived artist→genre map.

## On YouTube Music's own "Autoplay" setting

YTM has its own Up Next toggle ("Add similar content to the end of the queue") that appends unrelated suggested tracks once an album's tracklist ends. Album Roulette does **not** auto-disable it — that's a global YTM setting, and silently flipping it would surprise/annoy anyone using YTM outside the extension. Keep Rolling coexists with it instead: if Autoplay is on, you may briefly hear one of its suggestions in the moment before Keep Rolling's next pick takes over. Turn Autoplay off yourself in Up Next if you'd rather it never appear.

## Roadmap

- Remote status/kill flag for genre lookups (ToF-style status.json) before public release.
- Settings toggle: include Holiday-genre albums in full-random year-round (currently auto-excluded outside their season — Nov 15–Jan 5 for Christmas-ish genres, October for Halloween; the Holiday chip and Semi-🎲 are unaffected). Note: this filter only ever touches what iTunes/MusicBrainz label Holiday/Christmas/Halloween — in practice Western Christmas music — so it structurally can't catch e.g. Lunar New Year or Diwali albums, which carry ordinary genres.
- Recent-rolls list in the popover (history is already tracked).
- Companion mobile trigger: export album deep-links for an iOS Shortcut ("Hey Siri, random album").
