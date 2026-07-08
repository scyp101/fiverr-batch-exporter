# Fiverr Batch Exporter

**Back up your entire Fiverr business — every conversation, every order, every attachment — as a handful of ZIP downloads instead of thousands of individual files.**

![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-4c8bf5)
![Manifest](https://img.shields.io/badge/manifest-v3-1dbf73)
![License](https://img.shields.io/badge/license-MIT-blue)

Existing Fiverr export tools trigger one browser download *per file* — for a 600-chat inbox that means thousands of download prompts. Fiverr Batch Exporter builds everything into in-memory ZIP archives and triggers **one download per ZIP part**, automatically splitting parts when they exceed a configurable size limit (default **500 MB**).

## Features

- 📦 **Batched ZIP downloads** — the whole inbox lands in a few ZIPs, not thousands of files
- 🧾 **Orders too** — a second tab exports your seller orders: full timeline (placed → deliveries → revisions → completed), delivery messages and files, revision requests with reference attachments, buyer reviews with rating breakdowns, tags and your replies, plus earnings after fees and tips
- 🔍 **Analyze before you download** — a metadata-only pass shows message counts, attachment counts, and the exact download size per conversation *and* in total, before a single byte of attachments is fetched
- ✅ **Granular selection** — pick conversations, toggle attachments per chat, or untick individual files from an expandable per-chat file list
- 📝 **Choose your formats** — Markdown, HTML (styled chat view), and/or raw JSON; only what you tick gets exported
- 🕐 **Chronological everything** — conversation folders and files are prefixed with the last-message date; attachments are prefixed with the timestamp of the message they were sent with, so extracted files sort in order
- 🔗 **Working links** — attachment links inside the Markdown/HTML point at the renamed files, so they work after extraction
- 📊 **Live size estimate** — running totals and a ZIP-part estimate update as you change selections
- 🛟 **Resilient** — automatic retries with back-off, rate-limit friendly pacing, cancel-anytime (everything collected so far is still saved), and a failure report baked into the last ZIP
- 🔒 **Private by design** — runs entirely in your browser; nothing is sent anywhere except to Fiverr itself

## Installation

1. Download or clone this repository
2. Open `chrome://extensions/` (or `edge://extensions/`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the extension folder

## Usage

1. **Log in to Fiverr** in the same browser.
2. *Recommended:* in Chrome → Settings → Downloads, turn **off** "Ask where to save each file before downloading" so ZIP parts save without prompts.
3. Click the extension icon → **Open Export Manager**.
4. **Step 1 — Load contacts.** Fetches your complete inbox contact list.
5. **Step 2 — Analyze** *(recommended)*. Reads each selected chat's metadata (no files downloaded yet) and fills in per-chat message counts and attachment sizes, plus total-size stat tiles. Now you can:
   - untick whole conversations,
   - toggle **Include files** per conversation,
   - expand a row (▶) and untick individual attachments.
6. **Step 3 — Export.** Pick formats (Markdown / HTML / JSON) and the ZIP part limit, then **Start export**. Leave the tab open; progress and failures are logged live.

Because analysis already fetched the messages, the export step only has to download attachments — analyzed chats export noticeably faster.

### Orders tab

The **Orders** tab follows the same three steps for your seller orders:

1. **Fetch orders** — pick a status (Completed, Active, Delivered, Cancelled, Starred) and fetch. Fetch again with another status to merge more orders into the list.
2. **Analyze** — reads each order's timeline and file metadata; shows per-order file sizes plus totals including **earnings after fees** across the selection.
3. **Export** — produces one folder per order with a full timeline transcript (deliveries, revision requests, review + tags + your reply) and all delivery/revision files, timestamp-prefixed.

## Output structure

```
fiverr-export-2026-07-08_15-30-00-part01.zip
├── 2025-06-01_clientname/                       ← prefixed with last-message date
│   ├── 2025-06-01_clientname.md                 ← Markdown transcript (timestamped messages)
│   ├── 2025-06-01_clientname.html               ← styled chat view (if selected)
│   ├── 2025-06-01_clientname.json               ← raw API data (if selected)
│   └── attachments/
│       ├── 2025-05-28_14-22-05_brief.pdf        ← original name, prefixed with the
│       └── 2025-05-30_09-01-44_logo.png            timestamp of its message
├── 2025-05-20_otherclient/
│   └── …
└── _export-report.json                          ← summary + failed items (in the last part)

fiverr-orders-2026-07-08_16-10-00-part01.zip
├── 2025-06-14_FO51BE0C7BF83_clientname/
│   ├── 2025-06-14_FO51BE0C7BF83.md              ← order facts, earnings, line items, timeline
│   └── attachments/
│       ├── 2025-06-10_09-15-30_delivery.stl     ← delivery + revision files, prefixed with
│       └── 2025-06-12_11-02-11_reference.png       the timestamp of their event
└── _export-report.json
```

File modification times inside the ZIPs are set to the original message timestamps. Failed attachment downloads are flagged in the transcript and listed with their URLs in `_export-report.json` so you can retry them manually.

## Notes & limits

- The exporter paces itself (sequential fetches, small delays, back-off on HTTP 429) to avoid Fiverr rate limiting. A 600-chat inbox takes roughly 1–3 hours depending on attachment volume — leave the tab open; it warns you before closing mid-run.
- Keep the ZIP part limit at or below ~1900 MB; very large in-memory archives can exhaust browser memory. 500 MB is a safe default.
- If direct API calls are rejected, requests are automatically retried through an open fiverr.com tab — keep one open as a fallback.
- This uses Fiverr's own private inbox endpoints (the same ones the website calls). If Fiverr changes them, the extension will need updating.

## Privacy

All processing happens locally in your browser. The extension talks only to `fiverr.com` (for your conversations) and the attachment URLs Fiverr returns. No analytics, no external servers, no data collection.

## Contributing

Issues and pull requests are welcome. Useful areas: resume support for interrupted exports, per-attachment retry UI, and Firefox (WebExtensions) support.

## Acknowledgements

API endpoint behavior was originally mapped out by [fiverr-conversation-extractor](https://github.com/royal-crisis/fiverr-conversation-extractor); this project is an independent rewrite focused on batched, size-capped ZIP export.

## License

[MIT](LICENSE)
