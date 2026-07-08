# Fiverr Batch Exporter

**Back up your entire Fiverr business — every conversation, every order, every attachment — as a handful of ZIP downloads instead of thousands of individual files.**

![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-4c8bf5)
![Manifest](https://img.shields.io/badge/manifest-v3-1dbf73)
![License](https://img.shields.io/badge/license-MIT-blue)
![Privacy](https://img.shields.io/badge/data%20collection-none-1dbf73)

Most Fiverr export tools trigger one browser download *per file*. For an inbox with hundreds of chats that means thousands of download prompts — practically unusable. Fiverr Batch Exporter builds everything into in-memory ZIP archives and triggers **one download per ZIP part**, splitting parts automatically at a configurable size limit (default **500 MB**).

## Highlights

| | |
|---|---|
| 📦 **Batched ZIPs** | A 600-chat inbox lands in a few ZIP files, not thousands of downloads |
| 💬 **Messages** | Full chat transcripts with timestamps, reply threads, and every attachment |
| 🧾 **Orders** | Complete order timelines: deliveries with files, revision requests, reviews with tags and replies, earnings after fees, tips |
| 🔍 **Analyze first** | A metadata-only pass shows exact sizes per chat/order and in total — before downloading a single byte |
| ✅ **Granular selection** | Pick conversations or orders, toggle files per item, or untick individual attachments |
| 📝 **Your formats** | Markdown, styled HTML, and/or raw JSON — only what you tick is generated |
| 🕐 **Chronological naming** | Every file is timestamp-prefixed so extracted archives sort in true order |
| 🌗 **Dark & light themes** | Toggle in the header; your choice persists |
| 🔒 **Private by design** | Everything runs in your browser; no analytics, no external servers |

## Installation

> Not on the Chrome Web Store — installed as an unpacked extension.

1. [Download the latest release](../../releases) or clone this repository
2. Open `chrome://extensions/` (or `edge://extensions/`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the extension folder

## Usage

**Setup (once):** log in to Fiverr in the same browser, and — recommended — turn **off** "Ask where to save each file before downloading" in Chrome's download settings so ZIP parts save without prompts.

Click the extension icon → **Open Export Manager**. The exporter runs in its own tab; keep that tab open while it works.

### Messages tab

1. **Fetch all contacts** — loads your complete inbox contact list.
2. **Analyze** *(recommended)* — reads each selected chat's metadata (nothing is downloaded yet) and fills in message counts, attachment counts and sizes, plus total-size stat tiles with a ZIP-part estimate. Sort by any column to find your heaviest chats; search by username.
3. **Export** — pick formats and the part limit, then go. Progress and failures stream into the live log.

Analysis caches the messages, so analyzed chats export noticeably faster — the export step only has to download attachments.

### Orders tab

1. **Fetch orders** — choose a status (Completed, Active, Delivered, Cancelled, Starred). Fetch again with another status to merge more orders into the list.
2. **Analyze** — reads each order's timeline and file metadata. Tiles show file totals and **earnings after fees** across the selection.
3. **Export** — one folder per order with a full transcript and all delivery/revision files.

### Selection controls

After analysis, each row shows its attachment count and size. Per row you can untick the whole item, flip its **Include files** toggle, or expand it (▶) and untick individual files. Estimates update live as you change anything. Cancelling mid-export is safe — everything collected so far is still packed and downloaded.

## Output structure

```
fiverr-export-2026-07-08_15-30-00-part01.zip
├── 2025-06-01_clientname/                       ← prefixed with last-message date
│   ├── 2025-06-01_clientname.md                 ← transcript, timestamped messages
│   ├── 2025-06-01_clientname.html               ← styled chat view (if selected)
│   ├── 2025-06-01_clientname.json               ← raw API data (if selected)
│   └── attachments/
│       ├── 2025-05-28_14-22-05_brief.pdf        ← original name, prefixed with the
│       └── 2025-05-30_09-01-44_logo.png            timestamp of its message
└── _export-report.json                          ← summary + failed items (last part)

fiverr-orders-2026-07-08_16-10-00-part01.zip
├── 2025-06-14_FO51BE0C7BF83_clientname/
│   ├── 2025-06-14_FO51BE0C7BF83.md              ← facts, earnings, line items, timeline
│   └── attachments/
│       ├── 2025-06-10_09-15-30_delivery.stl     ← delivery + revision files, prefixed
│       └── 2025-06-12_11-02-11_reference.png       with the timestamp of their event
└── _export-report.json
```

- Attachment links inside the Markdown/HTML transcripts point at the renamed files, so they keep working after extraction.
- File modification times inside the ZIPs are set to the original message/event timestamps.
- Failed downloads are flagged in the transcripts and listed with their URLs in `_export-report.json` for manual retry.

## How it works

The extension talks to the same private endpoints the Fiverr website itself uses, authenticated by your existing browser session:

| Data | Source |
|---|---|
| Contact list | `GET /inbox/contacts` (paginated via `older_than`) |
| Conversations | `GET /inbox/contacts/{username}/conversation` (paginated via `timestamp`) |
| Order list | `GET /manage_orders/api/fetchOrders` (cursor pagination) |
| Order timeline, deliveries, reviews | Embedded `perseus-initial-props` JSON in `/orders/{id}/activities` |
| Order billing, tips, description | `GET /orders/{id}/ajax/fetch_order_details` |
| Attachments | The signed download URLs Fiverr returns |

Requests run sequentially with small delays and exponential back-off on HTTP 429 to stay well under rate limits. If a direct request is rejected, it is automatically retried through an open fiverr.com tab.

Because these are private endpoints, Fiverr may change them at any time — if an export suddenly fails, check for a newer version or open an issue.

## Notes & limits

- A large inbox takes time (roughly 1–3 hours for 600+ chats, depending on attachment volume). The pacing is deliberate; leave the tab open and it warns you before closing mid-run.
- Keep the ZIP part limit at or below ~1900 MB; very large in-memory archives can exhaust browser memory. 500 MB is a safe default.
- Contact/order lists, analysis summaries, and selections persist between sessions. Message content is re-fetched when needed, so signed file URLs stay fresh.

## Privacy

All processing happens locally in your browser. The extension communicates only with `fiverr.com` and the attachment URLs Fiverr returns. No analytics, no telemetry, no external servers, no data leaves your machine.

## Contributing

Issues and pull requests are welcome. Good first areas:

- Resume support for interrupted exports
- Retry-failed-items button fed by `_export-report.json`
- Firefox (WebExtensions) port
- Localization

## Acknowledgements

The inbox endpoint behavior was first mapped by [fiverr-conversation-extractor](https://github.com/royal-crisis/fiverr-conversation-extractor). This project is an independent, from-scratch implementation focused on batched size-capped ZIP export, pre-download size analysis, and order backup.

## Disclaimer

This is an unofficial tool, not affiliated with or endorsed by Fiverr. It automates access to your own account data for personal backup. Use reasonably and at your own risk.

## License

[MIT](LICENSE) © Kamil Siddiqui
