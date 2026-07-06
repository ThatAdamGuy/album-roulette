# Permission Justifications — Chrome Web Store Privacy Tab

Paste each paragraph verbatim into the corresponding field in the dashboard's Privacy practices tab.

---

## Permission: `storage`

```
Album Roulette uses chrome.storage.local to cache the user's YouTube Music library (album list and thumbnails), auto-tagged genre labels, and recent-pick history entirely on the user's own device. This lets the extension avoid re-fetching the library on every use and lets genre tagging persist across browser sessions without any account or server. No data is synced or transmitted; storage is local only.
```

---

## Permission: `contextMenus`

```
Album Roulette adds a right-click menu to its own toolbar icon that lists the genres present in the user's library (e.g. "Jazz", "Classical") so the user can roll a random album within a specific genre without first opening the popover. This is a convenience shortcut to the extension's core single purpose and does not add any menu items to web page content.
```

---

## Host permission: `music.youtube.com`

```
This is the extension's core function. Album Roulette reads the signed-in user's own YouTube Music library (liked albums and uploaded albums) via YouTube Music's own internal API, using the user's existing session/cookies, so it can select a random album to play. It also drives playback (loading the album's watch URL and detecting when the album ends) and injects the dice button and genre popover into the YouTube Music page UI. No other site is touched by this permission.
```

---

## Host permission: `itunes.apple.com`

```
Used to look up an album's genre so it can be labeled and filtered in the extension's genre chips. The extension sends only the album title and artist name (already visible in the user's own library) to Apple's public, keyless iTunes Search API and stores the returned genre locally. This is a background, best-effort enrichment step; no user account or personal data is involved.
```

---

## Host permission: `musicbrainz.org`

```
Used as a fallback genre lookup for albums the iTunes Search API cannot match (for example, some uploaded or independent albums). The extension sends only the album title and artist name to MusicBrainz's public, keyless API and stores the returned genre tag locally. Requests are rate-limited to MusicBrainz's published 1-request-per-second policy.
```

---

## Remote code

**Are you using Remote code?**

```
No. All code the extension runs is packaged in the extension itself. There is no eval() of remote strings, no dynamically loaded external scripts, and no remotely hosted logic. The only network calls are data fetches (JSON) to music.youtube.com's internal API and to the iTunes Search / MusicBrainz APIs for genre lookups — none of these responses are executed as code.
```

---

## Single purpose statement

```
Play a randomly-selected album, start to finish, from the user's own YouTube Music library, with optional genre-based filtering.
```
