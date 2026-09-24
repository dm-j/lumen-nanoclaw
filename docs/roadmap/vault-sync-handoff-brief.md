# Brief for the vault project's Claude: calendar-sync writer changes

Written 2026-09-23. **Self-contained: paste this to the Claude Code session in the Obsidian/vault project**
(`~/Projects/obsidian/lumen-data/lumen-data`, `scripts/calendar-sync/`). It owns `sync.js`, `lib.js`, `refile.js`, the crons
and the feed URLs; the lumen-nanoclaw project deliberately does not edit them. Background specs, for reference only:
`~/Projects/lumen-nanoclaw/docs/roadmap/calendar-event-note-body.md` and `calendar-day-index-links.md`.

## Why this is needed now

On 2026-09-23 every existing calendar event note (150) was already rewritten to a new layout by a one-off script
(`~/Projects/lumen-nanoclaw/scripts/calendar-note-body-backfill.mjs`, backup at `~/lumen-calendar-backup-20260923.tgz`).
**`sync.js` still writes the OLD layout.** Whenever an event changes upstream (its hash changes), sync re-renders that one
note the old way: the `**When:**` line and the raw description come back, and the whole body is overwritten,
destroying anything a person typed below the description. Fix the writer so the new layout is what sync produces and
maintains. The hourly cron (`--days=1`) must keep working throughout.

## The layout sync must produce

```markdown
---
(frontmatter: everything today, plus day_index; keys added by others are preserved)
---
# Event Title

> [Join the meeting](https://teams.microsoft.com/...)
> Meeting ID: 278 106 922 700
> Passcode: xTPgFd
> Phone Conference ID: 111 258 424#

^event-desc

(everything from here down belongs to the reader; never touched by sync)
```

1. **No `**When:**` line** (`local_start`/`local_end` and the other frontmatter already carry it; nothing reads the line).
2. **The upstream description goes in one `> ` quote block** (bare `>` for blank lines, `>` alone if empty), followed by a
   blank line and the line `^event-desc` (an Obsidian block ID that ends the block).
3. **Ownership zones on every re-render** of an existing note: sync-owned frontmatter keys are updated in place (keep keys
   others added, such as the `conflicts-with` list Routine writes); the title is regenerated; the quote block through the
   `^event-desc` line is regenerated; **everything after the `^event-desc` line is preserved byte for byte**. If the marker
   is missing on an existing note, keep the whole body and insert a new block after the title rather than overwriting.
4. **Screen the Microsoft Teams signature** out of the description before quoting it. Keep only, in this order: the join link
   (from `Click here to join the meeting<URL>` or `Join: URL`, written `[Join the meeting](URL)`, URL kept exactly), `Meeting ID: ...`,
   `Passcode: ...`, `Phone Conference ID: ...` (label case-insensitive). Drop the rules and everything else (Download Teams,
   Or call in, the tel: line, Find a local number, Learn More, organizer footer, Need help, the video-conference block).
   Text outside the signature (an organizer's agenda) is kept. Reference implementation to port or reuse:
   `screenTeams`/`teamsKeepers` in `scripts/calendar-note-body-backfill.mjs`; the backfill and sync must agree.
5. **Hash.** `event_hash` must stay computed from the parsed original event (raw description included), never from the
   screened text. Add a format-version constant to `hashFields` so that each note re-renders exactly once after this
   ships, and bump it whenever the layout changes again.

## New frontmatter field: `day_index`

Every event note gets a link to the `_index.md` of each day it covers: a quoted string for one day, a YAML block list for
several. Days run from `date` to `end_date` inclusive (both already local to the event; for all-day events `end_date` is already
the inclusive last day).

```yaml
day_index: "[[07-Daily/Calendar/2026/09/23/_index|2026-09-23]]"
day_index:
  - "[[07-Daily/Calendar/2026/09/30/_index|2026-09-30]]"
  - "[[07-Daily/Calendar/2026/10/01/_index|2026-10-01]]"
```

- `lib.js`: `yamlValue` has no array support (`JSON.stringify(String(v))`), so `buildFrontmatter` needs a list form.
- Routine's writer already emits this identically: `dayIndexFrontmatter` in
  `~/Projects/lumen-nanoclaw-instance/mcp-shims/routine/calendar/day-index.ts`, with a selftest beside it.
- `refile.js` moves notes between day folders on timezone changes and patches fields with `patchFrontmatterField`, whose
  regexp (`^key: .*$`) cannot replace a multi-line list. Re-derive `day_index` whenever `date`/`end_date` change there, with a
  list-aware patch. Also make sure `refile.js` never rewrites the body (respect the ownership zones above).
- **Existing 150 notes do not have `day_index` yet**: backfill after the writer change, idempotent, skipping `_index.md` and the
  `_series/` masters, including cancelled and `DELETED-` notes. Days without an `_index.md` (created lazily) leave unresolved links;
  decide whether sync should create the day's `_index.md` when it writes an event note.

## A second, separate bug in `refile.js`

It deletes a day folder that holds only `_index.md` (~line 120). The daily notes now keep a `## Notes` quote block
(`^daily-notes`) inside `_index.md` that agents and David write into, so an `_index.md` whose notes block is non-empty (any
`> - ...` item) must keep its folder, or the notes are destroyed.

## Constraints and checks

- Do not change anything below a note's `^event-desc` line, and do not touch `_index.md` bodies or `_series/` masters beyond the above.
- `kind: "work"` (a second feed) already exists; nothing here is feed-specific except the Teams screen.
- Test on a copy of `07-Daily/Calendar` first (`scripts/calendar-sync/test.js` exists). Then: run one `sync.js --days=30`; edit a
  test event upstream (or simulate a changed hash) and confirm the note re-renders with the layout, keeps text typed below
  `^event-desc`, and keeps `conflicts-with`/other extra keys.
- Done when: every event note has exactly one `^event-desc` line and one `day_index`; none contains `**When:**`, `Download Teams`
  or an 80-underscore rule; a re-sync of an unchanged event is still a no-op; a changed event round-trips as above.
