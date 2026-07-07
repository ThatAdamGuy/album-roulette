# Album Roulette for YouTube Music 🎲

One click plays a **random album from your YouTube Music library, start to finish** — the feature no streaming service has ever shipped.

**Website:** [thatadamguy.github.io/album-roulette](https://thatadamguy.github.io/album-roulette/) · **Privacy policy:** [privacy.html](https://thatadamguy.github.io/album-roulette/privacy.html)

## What it does

- A **🎲 button** in the YouTube Music header (plus the toolbar icon and a keyboard shortcut, `Alt+Shift+R`) picks a random album from your library — including uploaded albums — and plays it from track 1, in order, no shuffle. It avoids repeating your last 20 picks.
- **Genre picks**: the ▾ next to the die opens a picker with chips like "Jazz · 88" that roll within a genre. Albums are genre-tagged automatically in the background using free public music databases; a large library takes about an hour, once, and the results are cached forever.
- **Semi-🎲 "Deal me 6"**: six album covers from six different genres — pick by mood.
- **Keep Rolling 🔁** (optional): when an album finishes, a gentle four-note chime marks the boundary, then another random album starts automatically (staying in the same genre if you rolled one).
- **Seasonal smarts**: holiday albums sit out of fully-random rolls outside their season, but stay available via their genre chip.

## Privacy

No account, no API key, no server, no analytics. Your album list, genre tags, and settings live in your browser's local extension storage. The only data that ever leaves your browser is an album's **title and artist name**, sent to two public music databases (Apple's iTunes Search API and MusicBrainz) to identify its genre. Details in the [privacy policy](https://thatadamguy.github.io/album-roulette/privacy.html).

## Install

**Chrome Web Store listing coming soon.** Until then:

1. Download or clone this repo
2. `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the folder
4. Open [music.youtube.com](https://music.youtube.com) (signed in) and click the 🎲

Requires a YouTube Music account with albums saved to your library. Chrome/Chromium only, desktop only.

## KindnessWare 🎵

Album Roulette is free, with no ads or upsells — ever. If it makes your listening better, tell the author, and consider donating whatever feels right to an arts-related cause of your choice (music education, your local venue, a school band program…).

---

## For developers

Vanilla JS, Manifest V3, no build step. YouTube Music has no official API, so this extension works the way the YTM web app itself does — which makes some of the engineering below unusual, and all of it potentially fragile if Google changes things.

### Components

- **`page.js`** (MAIN-world content script) — talks to YTM's internal InnerTube API (library album shelves with continuation paging, authenticated via a SAPISIDHASH computed from the page's own cookies). Rolls resolve the chosen album into its first/last track IDs, full track list, and album playlist ID, then navigate to the album's playlist page and press Play (with a `/watch?v=…&list=…` fallback if the playlist page stalls, since watch URLs autoplay natively). Album-end detection uses three cooperating signals — a pre-end timer, the media `ended` event, and a fast track-transition poll with carryover suppression — because YTM's gapless preloading flips player state to the next queue item seconds before audio actually ends. A rolling debug log is kept in `localStorage.ytra_log`.
- **`content.js`** (isolated-world content script) — the 🎲/▾ UI, genre popover (built with DOM APIs only: music.youtube.com enforces Trusted Types, so `innerHTML` throws), album cache (24h TTL), pick history, the Keep Rolling boundary handler (pause → chime → next roll, with a guard that suppresses YTM Autoplay audio during the handoff), and the genre-enrichment pump.
- **`background.js`** (service worker) — routes toolbar clicks, the keyboard shortcut, and the toolbar right-click genre menu to a YTM tab (preferring the audible one); proxies genre-lookup fetches (host-permission fetches are CORS-exempt, and iTunes' CORS headers are unreliable); drives the tagging-progress badge.

### Genre pipeline (keyless by design)

1. **iTunes Search API** — primary. Its limiter is per-IP, burst-sensitive, and stochastic: ~4s spacing is reliable; on a 403, defer the album and back off with jitter — never retry-loop (sustained hammering earns long penalty windows, and datacenter IPs get blanket-blocked, which is one reason this extension will never proxy through a server).
2. **MusicBrainz** — fallback for albums iTunes can't match; community tags come back inline in one search request; hard 1 req/sec limit respected.
3. Raw genre strings are stored permanently; mapping to display buckets is a lookup table plus substring rules, so re-bucketing never requires re-fetching.

### Why Keep Rolling coexists with YTM's Autoplay

YTM's own Up Next "Autoplay" toggle appends suggested tracks when a queue ends. Album Roulette deliberately does **not** flip that setting — it's global, and silently changing it would surprise people outside the extension. Instead the boundary handler suppresses stray Autoplay audio during the chime/handoff window. If Autoplay is on you may still see (not hear) a suggested track flash in the player bar between albums; turn Autoplay off in Up Next if you'd rather not.

### Roadmap

- Remote status/kill JSON hosted on the project site, so genre lookups can be disabled gracefully for everyone if a metadata API changes its rules.
- Settings toggle: include holiday albums in fully-random rolls year-round. (The current seasonal filter only affects what the metadata sources label Holiday/Christmas/Halloween — in practice Western Christmas music; festive albums from other traditions carry ordinary genres and are never filtered.)
- Recent-rolls list in the popover.
- Companion mobile trigger: exported album deep-links + an iOS Shortcut ("Hey Siri, random album").

---

*Album Roulette is an independent project, not affiliated with, endorsed by, or sponsored by YouTube, Google, or Apple.*
