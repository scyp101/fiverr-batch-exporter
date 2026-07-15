# Changelog

## 1.2.3 — 2026-07-15

### Fixed
- Messages sent by a seller's Fiverr AI assistant (e.g. "Ryn") were attributed to the seller in Markdown/HTML transcripts. They are now detected via `senderData.isPersonalAssistant` and labelled with the assistant's name — auto-detected from conversation metadata when available, with a manual fallback field in the export options. Assistant messages get a dashed border in HTML transcripts; raw JSON output is unchanged.

## 1.2.2 — 2026-07-09

### Fixed
- Order analysis no longer fails when Fiverr's bot protection rate-limits bursts of order-page loads (HTTP 403). Blocked requests are first retried through an open fiverr.com tab, then after 15–45s cooldowns; failed orders automatically get a second pass after a 60s cooldown. Order analysis now paces at ~1 request/second.

## 1.2.1 — 2026-07-09

- No functional changes. Version bump because the `v1.2.0` tag was consumed by an immutable release in a prior incarnation of this repository and cannot be reused.

## 1.2.0 — 2026-07-09

### Added
- **Orders tab** — export seller orders alongside conversations:
  - order list with per-status fetches (Completed, Active, Delivered, Cancelled, Starred) that merge into one table
  - full timeline transcripts: deliveries with files, revision requests with attachments, buyer reviews with rating breakdowns, tags and seller replies, upsells, due-date changes
  - earnings after fees and tips, offer descriptions, line items
  - per-order and per-file selection, sortable/searchable table
- **Light theme** with a persisted header toggle (dark remains default)
- Sortable columns on both tables (name/date/messages/attachment size; buyer/date/total/file size)

### Changed
- Custom-themed select dropdowns and a segmented − / + stepper for the ZIP part limit
- "Keep this tab open" notice restyled as a critical alert
- All colors moved to a token system so both themes stay consistent

## 1.1.0 — 2026-07-08

### Added
- **Analyze step** — metadata-only pass showing per-chat message counts, attachment counts/sizes, and total-size stat tiles with a ZIP-part estimate before anything is downloaded
- Per-chat **Include files** toggle and per-attachment untick list
- Format selection (Markdown / HTML / JSON) — only selected formats are generated
- Styled HTML chat transcript
- Session persistence for contact list, analysis summaries, and selections
- Extension icons

## 1.0.0 — 2026-07-08

Initial release:

- Fetch the full inbox contact list (paginated)
- Export conversations as Markdown with timestamps, reply threads, and attachments
- All output packed into in-memory ZIPs — one browser download per part, split at a configurable size limit (default 500 MB)
- Timestamp-prefixed file naming for chronological sorting
- Retry with back-off, rate-limit-friendly pacing, cancel-safe exports, failure report inside the archive
