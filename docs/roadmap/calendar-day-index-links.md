# Calendar event notes: `day_index` link to the day's `_index.md`

Decided 2026-09-23 (David). Every calendar event note gets a frontmatter property linking to the
`_index.md` of each day it covers: a single quoted string for a one-day event, a YAML block list for a
multi-day one. Needed so an event note can be navigated to (and queried by) its day's index and its
`## Notes` block (see [routine-daily-notes.md](routine-daily-notes.md), 2026-09-23 addendum).

## Format

Property name `day_index` (snake_case like `all_day`/`utc_start`). Full vault path in the link because every
day's file is literally named `_index`; the `|YYYY-MM-DD` alias is the display text.

```yaml
day_index: "[[07-Daily/Calendar/2026/09/23/_index|2026-09-23]]"      # one day
day_index:                                                            # several days
  - "[[07-Daily/Calendar/2026/09/30/_index|2026-09-30]]"
  - "[[07-Daily/Calendar/2026/10/01/_index|2026-10-01]]"
```

Days = every date from `date` to `end_date` inclusive (both already local to the event's `tz`; for all-day
events `end_date` is already the inclusive last day, `inclusiveEndDate` in `lib.js`).

## Split of work (ownership: see memory `vault-calendar-sync-ownership`)

**Done here (Routine side), 2026-09-23.** `mcp-shims/routine/calendar/day-index.ts` +
`vault-events.ts`'s `buildFrontmatter` emit the field for every routine-owned note (create and the
`personal_edit` full rewrite both, so an edit never drops it). Self-check `day-index.selftest.ts` passes; verified live
on a scratch day (created, edited, removed). There were 0 routine-owned notes to backfill.

**Hand off to the Obsidian project's Claude (`scripts/calendar-sync/`) — not done:**

1. **`lib.js`**: `yamlValue` has no array support (`JSON.stringify(String(v))`), so `buildFrontmatter`
   must learn to write a list value as the block form above. Then have the event-note writer in `sync.js`
   (the `buildFrontmatter({... kind: occ.kind ...})` call, ~line 112) add `day_index`. Keep it out of
   `event_hash`/`contentHash` inputs unless you want every note re-upserted once.
2. **`refile.js`** moves notes between day folders when the timezone changes and patches `date` etc. via
   `patchFrontmatterField`, whose regexp (`^key: .*$`) cannot replace a multi-line block list. `day_index`
   must be re-derived whenever `date`/`end_date` change there, with a list-aware patch. Also still open from
   the Notes-block work: it must not delete a day folder holding only a non-empty `_index.md`.
3. **Backfill the existing 150 event notes** (`07-Daily/Calendar/YYYY/MM/DD/*.md` excluding `_index.md` and the
   19 `_series/` masters, which represent a series, not a day). No multi-day notes exist today. Include
   cancelled and `DELETED-` notes so the field is uniform. Idempotent script, run once **after** (1) and (2)
   land: if sync's upsert rebuilds a note's frontmatter from scratch, a backfill done first would be undone.
   Verify with a sample note and a grep that every event note has exactly one `day_index` key.
4. Dangling links are expected: `_index.md` is created lazily (only 32 exist for 150 notes), so many links
   point at days with no `_index.md` yet. Obsidian shows them as unresolved until the file exists. Decide
   whether sync should create the day's `_index.md` when it writes an event note.

Routine's own `parseFrontmatter` (`calendar/vault-events.ts`) reads only flat `key: value` lines: a
`day_index:` list is ignored by it (the item lines don't match), which is safe. Nothing in Routine reads the field.
