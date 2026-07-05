# Album Roulette for YouTube Music 🎲

One click plays a **random album from your YouTube Music library, start to finish** — the feature no streaming service has ever shipped.

## How it works

- A 🎲 button appears in the YouTube Music header (and the extension's toolbar icon does the same thing from any tab).
- Click it: the extension reads your library's album list — including **uploaded albums** — through YouTube Music's own internal API, using your existing signed-in session. Nothing leaves your browser; there are no accounts, keys, or servers.
- It picks an album at random (avoiding your last 20 picks), navigates to it, and presses Play. Track 1, in order, no shuffle.
- **Genres**: the ▾ next to the die (or right-click the die) opens the genre picker — chips like "Jazz · 74" play a random album within that genre, and **Semi-🎲 "Deal me 6"** shows six covers from six different genres to choose from. Genres come from the keyless iTunes Search API, tagged quietly in the background (~20 lookups/min; a big library takes under an hour, once, and is cached forever). The extension's toolbar icon also gets a right-click genre menu.

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open [music.youtube.com](https://music.youtube.com) (signed in) and click the 🎲

## Architecture (no build step, vanilla JS)

- `manifest.json` — MV3. Permissions: `storage`, `contextMenus`.
- `page.js` — MAIN-world content script. Talks to the InnerTube API (`FEmusic_liked_albums` + `FEmusic_library_privately_owned_releases` shelves, with continuation paging) authenticated via SAPISIDHASH computed from the page's own cookies. Playback: resolves the picked album to its Play-button `watchEndpoint` (track 1 + album playlist; `RDAM…` radio/shuffle endpoints skipped) and dispatches `yt-navigate` on `ytmusic-app` — starts playback directly, usually without a page load. Pauses before rolling so YTM's "Leave site?" prompt never arms, and keeps a sessionStorage flag + click-Play fallback loop for the cases where YTM's router forces a real navigation.
- `content.js` — isolated-world content script. Header 🎲+▾ buttons, genre popover (chips + Semi-🎲 deal grid), toasts, album cache (`chrome.storage.local` `ytra_albums_v2`, 24h TTL, includes thumbnails), pick history, and the genre enrichment pump: iTunes Search API lookups (raw `primaryGenreName` stored permanently under `ytra_genres`, keyed by browseId), throttled to the API's ~20/min limit, single-tab via the Web Locks API, resumable. Raw genre → display bucket mapping lives in one table (`GENRE_TO_BUCKET`) so re-bucketing never requires re-fetching. Bridges to `page.js` via `window.postMessage`.
- `background.js` — service worker; routes toolbar clicks and the toolbar-icon context menu (per-genre rolls, rebuilt from `ytra_buckets` counts) to a YTM tab, preferring the audible one; opens YTM if none exists.

## Genre data sources (all keyless, all from the user's own IP)

1. **iTunes Search API** — primary. Paced at 4s/request (the limiter is per-IP, burst-sensitive, and stochastic; 403 = defer album + escalating jittered pause, never retry-loop). Fetched from the background worker (host permission) because iTunes' CORS header is unreliable.
2. **MusicBrainz** — fallback for albums iTunes can't match. One search request returns community tags inline; hard 1 req/sec limit respected.
3. Future: Chrome built-in AI (Gemini Nano, Chrome 138+, hardware-gated) as an opportunistic offline tier; possibly a bundled MusicBrainz-derived artist→genre map.

## Roadmap

- Remote status/kill flag for genre lookups (ToF-style status.json) before public release.
- Companion mobile trigger: export album deep-links for an iOS Shortcut ("Hey Siri, random album").
