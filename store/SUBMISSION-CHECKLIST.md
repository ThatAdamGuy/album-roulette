# Chrome Web Store Submission Checklist — Album Roulette for YouTube Music v0.3.0

Ordered steps. Work top to bottom.

1. **One-time developer registration** ($5, one-time, covers all future items)
   - Go to https://chrome.google.com/webstore/devconsole
   - Sign in with the Google account that should own this listing.
   - Pay the one-time $5 registration fee if not already registered.

2. **Create a new item, upload the ZIP**
   - Click "New Item" and upload `store/album-roulette-0.3.0.zip` (built alongside this checklist — see repo root; verified contents below).

3. **Paste the listing fields**
   - Use `store/listing.md` for: Item name, Summary, Detailed description, Category (Entertainment), Language (English).

4. **Upload screenshots**
   - Follow `store/screenshots.md` for the 4 suggested shots (1280x800 PNG). Capture them from a real music.youtube.com session before this step, since they aren't generated automatically.

5. **Fill out the Privacy practices tab**
   - **Single purpose**: paste the single-purpose statement from `store/permission-justifications.md`.
   - **Permission justifications**: paste the `storage`, `contextMenus`, and three host-permission paragraphs from `store/permission-justifications.md`.
   - **Remote code**: paste the "No" answer from `store/permission-justifications.md`.
   - **Data usage**: follow `store/data-usage-disclosures.md` — check only "Website content" as collected (purpose: App functionality), leave everything else unchecked, and check all three certification boxes.
   - **Privacy policy URL**: `https://thatadamguy.github.io/album-roulette/privacy.html`
     (Confirm this page is live before submitting — CWS will reject if the URL 404s.)

6. **Choose visibility**
   Leave this choice to Adam. Options:
   - **Public** — anyone can find and install it from the Web Store; no invite needed. Best once you're comfortable with strangers using it and leaving reviews.
   - **Unlisted** — installable by anyone with the direct link, but won't appear in search/browse. Good for a soft launch you can share informally without it being publicly discoverable yet.
   - **Private** — restricted to specific Google accounts or a Google Group you designate (trusted testers only). Matches the invite-only approach used for Thriend Or Faux; best if you want a closed beta first.

7. **Submit for review**

8. **Typical review time**: usually a few hours to a few business days for a new item; can occasionally take longer if the extension trips automated flags (host permissions + remote-ish looking API calls sometimes add scrutiny — the justifications in this pack are written to preempt that). Adam will get an email when it's approved, rejected, or needs more info.

9. **After approval**
   - The item's unique ID appears in the address bar of its dashboard listing page (`https://chrome.google.com/webstore/devconsole/<developer-id>/<item-id>/edit`) and on the public listing URL (`https://chromewebstore.google.com/detail/<item-id>`).
   - Update the install link on `docs/index.html` (the GitHub Pages site) with that public listing URL once live.
