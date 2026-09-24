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
  `_series/` masters, including cancelled and `DELETED-` notes.
- Every day folder that holds event notes already has an `_index.md` (`ensureIndex(startStr)`, ~line 71; verified 32 of 32 on
  2026-09-23), so single-day links resolve. For a multi-day event, call the same ensure for **every covered day**, so each
  `day_index` link resolves.

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

## Optional, added 2026-09-24: hybrid throttle for `sync.js` (execute on first hit, then throttle)

Not part of the layout change above; a separate improvement worth doing in the same pass. Today every call to Routine's calendar tools
(`calendar_personal_today/tomorrow/week`) runs `sync.js --days=N` before reading: a network fetch plus file writes, on every call. The
hourly cron runs it too, and nothing stops two runs overlapping. A future per-turn "Now and Next" injection for Lumen
([lumen-now-and-next.md](lumen-now-and-next.md)) will want to read the calendar notes without syncing at all.

**Semantics (David: "a hybrid: execute on first hit, then throttle subsequent").** Leading-edge execution, concurrent callers
coalesced onto the in-flight run, then a throttle window. A caller passes something like `--if-older-than=<seconds>`; then, in order:

| Situation when a caller arrives | Behaviour |
|---|---|
| A sync is **running** (lock held) | **Wait** for it (bounded, e.g. 30 s) and share its result; do **not** start another. The caller gets fresh data, which skipping would not give it. |
| No sync running, and the last **successful** sync is older than the window, or did not cover the requested `--days` | **Run now** (leading edge). |
| No sync running, and a successful sync inside the window already **covers** the requested `--days` | **Skip**; read the notes as they are. |
| The last attempt **failed** | Do not treat it as a success (the next hit retries), but keep a short failure cooldown (for example 30 s) so a feed that is down is not hammered by every call. |

- **No trailing run is needed.** Staleness is bounded by the window, and the first hit after the window is itself a leading-edge run,
  so nothing has to be scheduled in the background.
- **Window:** a 2 to 5 minute default for interactive callers is plenty (calendar feeds often lag anyway). The hourly cron passes no
  flag and always runs.
- **Coverage-aware:** record the last successful sync's finish time and the `--days` window it covered (a small state file under the
  script's `logs/` or next to `current-tz.json`); a recent 7- or 30-day sync satisfies a later 1-day request.
- **Lock:** a lock file for the single-flight part, with a stale-lock timeout as `inbox-watch.sh` already does for its own lock.
- **Callers** then pass the flag: Routine's `syncCalendar` in `mcp-shims/routine/calendar/vault-events.ts` (our repo) is the only current
  one. If the flag is not available yet, a caller-side version of the same table (timestamp file plus the same lock) in that one
  function is an acceptable stopgap.
