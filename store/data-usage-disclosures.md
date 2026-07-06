# Data Usage Disclosures — Chrome Web Store Privacy Tab

Recommended answers for the "Privacy practices > Data usage" form. Chrome's standard category list, with a one-line reasoning per category. Be conservative — when in doubt, disclose.

---

## Data category checklist

| Category | Collected? | Reasoning |
|---|---|---|
| Personally identifiable information | **Not collected** | The extension never reads or transmits name, email, address, phone, or any account identifier. It only reads the album list already visible to the signed-in user via YTM's own API, using the user's existing session — it doesn't extract or send anything that identifies the person. |
| Health information | **Not collected** | Not applicable to this extension's function. |
| Financial and payment information | **Not collected** | Not applicable; no purchases, no payment forms, no financial data touched. |
| Authentication information | **Not collected** | The extension rides on the user's existing YouTube Music browser session (cookies) to call YTM's internal API, but it never reads, stores, or transmits passwords, tokens, or session identifiers itself. |
| Personal communications | **Not collected** | The extension does not access email, messages, chat, or any communications content. |
| Location | **Not collected** | No geolocation API is used and no location data is inferred or transmitted. (Note: outbound requests to iTunes/MusicBrainz originate from the user's own IP as with any web request, but the extension does not collect or use location itself.) |
| Web history | **Not collected** | The extension does not read or transmit the user's browsing history across sites. It only reads the album/library data on music.youtube.com needed to function. |
| User activity | **Not collected** | Recent-pick history and Keep Rolling state are stored only, locally, in chrome.storage.local for the extension's own operation (avoiding repeat picks). This data is never transmitted anywhere, so it is not "collected" in the Chrome Web Store sense (collection = transmitted off-device). |
| Website content | **Collected — disclose** | The extension sends album title and artist name (read from the user's YouTube Music library, i.e. content from the site the user is on) to two public, keyless third-party APIs (iTunes Search, MusicBrainz) purely to look up each album's genre. This is genuinely "website content" leaving the device, so it should be disclosed rather than marked "not collected," even though it's minimal (title/artist only, no personal data, no account link). |

### How to fill the form

- Check **only** "Website content" as collected.
- For "Website content," select purpose: **App functionality** (genre tagging/filtering is a core feature).
- Leave every other category unchecked / "not collected."

---

## Certification checkboxes

All three should be checked:

- [x] **This extension does not sell or transfer user data to third parties**, outside of the approved use cases. (True — album title/artist go to iTunes/MusicBrainz solely for a genre lookup the user benefits from directly; nothing is sold or shared for advertising, analytics, or any unrelated purpose.)
- [x] **This extension does not use or transfer user data for purposes that are unrelated to its single purpose.** (True — the only outbound data, album title+artist, is used exclusively to power the genre-chip feature described in the single purpose statement.)
- [x] **This extension does not use or transfer user data to determine creditworthiness or for lending purposes.** (True — not applicable in any way to this extension.)
