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

## The sync pipeline — identified 2026-09-18

David confirmed it's a cron job. Found in `crontab -l`: `scripts/calendar-sync/sync.js`
under `~/Projects/obsidian/lumen-data/lumen-data/` (a **separate personal-vault repo,
not NanoClaw or its instance repo** — explains why grepping both of those found
nothing), running at three cadences (`--days=1` hourly, `--days=7` every 12h,
`--days=30` every 10 days).

Read `sync.js` directly — the original "unknown pipeline, might overwrite" risk is
real but narrower than feared:
- `_index.md` is create-once (`if existsSync return` before writing) — never
  overwritten once it exists, matching the template this doc's `daily_note` shim
  already writes.
- An existing event note gets its frontmatter **patched in place** (specific fields
  updated), not wholesale rewritten.
- A removed-upstream event gets `status: cancelled` patched in, never deleted —
  matches the `_index.md` dataview query's own `where status != "cancelled"` filter.
- Sync only ever touches notes matching a synced event's own upstream id. A
  `routine`-added event using its own synthetic id has no reason to ever be touched by
  a sync run — it simply isn't in the set of ids the sync fetched.

Net: `routine` managing a **local-only copy** (add/edit events that were never in the
upstream feed to begin with) looks genuinely low-risk, not merely "probably fine."

## Refined plan (still not started) — read-triggered sync, not a global wake-script

Original framing considered forcing a sync on every `routine` wake via the `wake_script`
mechanism from [routine-daily-notes.md](routine-daily-notes.md). Reconsidered: David
flagged that parsing potentially large recurring VEVENT records could add real latency,
and separately, `wake_script` runs unconditionally on *every* wake — including ones about
reminders/tasks that have nothing to do with the calendar. Better shape: the sync call
belongs inside whatever new vault-calendar *read* tool gets built (call a
`calendar_sync-host` wrapper around `sync.js --days=1` right before reading), so the cost
is paid only when a calendar read is actually happening — self-contained, not a tax on
every wake. `sync.js` itself is host-side (lives in the separate vault repo, not mounted
into any container), so this needs its own host-shim wrapper either way — same pattern
`daily_note` already uses for `obsidian`.

"Let Routine manage a copy" is the operative framing per David: not a live two-way
calendar API integration, a local vault-only copy Routine can freely add notes to
(including inside an individual event's own note, not just the day's `_index.md`).

## Related idea: keep the vault's local-time fields synced to Lumen's own timezone

Also raised 2026-09-18, same conversation: if/when Lumen gets her own "timezone" shim
(not built yet — no such tool exists today, checked), whatever changes her effective
timezone should also invoke the vault's **already-existing** `set-local-tz.js`
(`~/Projects/obsidian/lumen-data/lumen-data/scripts/calendar-sync/set-local-tz.js` — read
directly, confirmed real): `node set-local-tz.js <IANA tz>` walks every event note under
`07-Daily/Calendar/`, recalculating `local_start`/`local_end` from each note's own
canonical `utc_start`/`utc_end` (never touches `tz`/`start_wall`/`status`/`event_hash`,
so it never fights `sync.js`'s own idempotency — confirmed via its own header comment).
The design intent David stated: canonical is always UTC (`utc_start`/`utc_end`, untouched
by this), and "local" in the vault is always kept equal to whatever Lumen's own current
local timezone is — so a timezone change (like the real one already logged in the vault,
`02-Areas/Personal/Facts/2026-09-16 — Fact — Timezone Change to America-Chicago Sept
2026.md`) propagates from Lumen's own config into the vault's displayed times
automatically, rather than the two silently drifting apart. Likely hook point on the
NanoClaw side: wherever an agent group's effective timezone actually changes (`ncl groups
config update --timezone`, or a future dedicated timezone tool) — not designed, not
scoped, just the plausible seam.

## Other open questions, not decided

- **Does this replace the ICS-feed shims entirely, or supplement them?** A local vault
  read has different failure modes than a live network fetch (staler by however long the
  external sync lags; but works with no network dependency and no ICS URL secret) —
  worth deciding whether `routine` needs both, or just one.
- **Event-note schema — confirmed via `sync.js`/`set-local-tz.js` source, not just the
  `_index.md` query anymore**: `utc_start`/`utc_end` (canonical), `local_start`/
  `local_end` (derived, recalculated by `set-local-tz.js`), `tz`, `start_wall`, `status`,
  `event_hash` (sync's own idempotency key) — plus `date`/`end_date`/`all_day` used by
  the dataview filter. Still not exhaustively confirmed (only the fields these two
  scripts touch are known; there may be others `routine` would need for a full
  read/edit tool).
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
