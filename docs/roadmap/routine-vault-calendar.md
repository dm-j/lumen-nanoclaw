# `routine` — read/edit calendar via the vault's local copy, not the ICS feed

Raised 2026-09-18, thinking out loud (not scoped, not started): David wants to consider
switching `routine`'s calendar-read feature from its current ICS-feed fetch to instead
draw from the Obsidian vault's own local calendar copy — and, since that copy lives in
files `routine` can already write to, let `routine` add and edit (not delete) calendar
events **in that local copy only**, not the real upstream calendar.

## What exists today

`routine`'s `calendar_personal_today`/`tomorrow`/`week` (`mcp-shims/routine/calendar/`)
fetch and parse an ICS feed directly via `node-ical`
(`fetch-calendar.ts`, `CALENDAR_PERSONAL_ICS_URL` env var) — no vault involvement at all.

Separately — found while building [routine-daily-notes.md](routine-daily-notes.md) —
the vault already has a **local, file-based mirror** of calendar events: each day folder
under `07-Daily/Calendar/{YYYY}/{MM}/{DD}/` contains an `_index.md` (a dataview query
listing that day's events) plus one sibling `.md` file per event (e.g.
`dinner-at-chauhan-60pmap1i.md`, `work-6orjioj1-2026-09-18.md`), with frontmatter fields
at least including `status`, `date`, `end_date`, `all_day`, `utc_start` (inferred from the
`_index.md` dataview query's `where`/`sort` clauses, not directly inspected). Something
keeps this mirror in sync with the real calendar — grepped this repo and the private
instance repo for anything that writes here and found nothing, so whatever populates it
is **external to NanoClaw entirely** (most likely a separate Obsidian community plugin
syncing Google Calendar → vault notes). Identity and behavior of that pipeline is
unknown.

## The key open risk — must be resolved before this is safe to build

If that external sync pipeline treats `07-Daily/Calendar/` as its own disposable output
(e.g. a full resync/overwrite from the upstream calendar on each run), anything `routine`
adds or edits there could be silently clobbered or produce a duplicate on the next sync
cycle. Before writing a single line: find out what that pipeline actually is, whether it
merges or overwrites, and whether it has any notion of "locally-added, not from upstream"
events it's designed to leave alone. If it does a blind overwrite with no such
distinction, `routine`-added events need either a way to signal "don't touch me" to that
pipeline, or a separate location/marker that survives its sync — not just written into
the same per-day folder and hoped for the best.

## Other open questions, not decided

- **Does this replace the ICS-feed shims entirely, or supplement them?** A local vault
  read has different failure modes than a live network fetch (staler by however long the
  external sync lags; but works with no network dependency and no ICS URL secret) —
  worth deciding whether `routine` needs both, or just one.
- **Exact event-note schema** — the frontmatter fields above are inferred from a query,
  not confirmed against the external pipeline's actual writer. Needs the same kind of
  live-checked verification this whole `daily_note` effort did for the day-folder
  convention, not another guess.
- **"Edit, not delete"** — same append-only-style caution already applied to the daily
  note (`routine-daily-notes.md`'s no-overwrite decision). An edit here likely means
  "change specific fields of an existing local event note" (time, title) rather than a
  blind full-file rewrite — needs its own explicit scope once this is picked up, not
  assumed safe by default.
- **Relationship to `routine-daily-notes.md`'s dataview-stripping fix** — that fix
  treats the `_index.md` dataview block as pure noise to discard. If `routine` starts
  writing/editing the *sibling event files* that block's query reads from, the two
  features touch the same folder structure for related-but-different reasons; worth
  reviewing both together once this is scoped, not assuming they're fully independent.

## Status: not started

Idea only — captured per the roadmap-maintenance rule so it isn't lost, not because any
part of it has been designed yet.
