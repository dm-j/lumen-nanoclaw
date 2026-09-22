# `routine` — detect and resolve Routine-added vs. authoritative calendar conflicts

Raised 2026-09-22, right after [routine-vault-calendar.md]'s replacement of the ICS-feed
shims shipped (that item's own file has since been deleted — see `docs/roadmap.md`'s
"Closed 2026-09-22" entry for what it covered). Not scoped, not started.

## The problem

`routine` can now add its own events to the vault's local calendar copy
(`calendar_personal_add`, `kind: "routine"` frontmatter so the sync pipeline's own
staleness sweep never touches them — see the Closed entry for why that field matters).
But nothing stops the *same* event from also landing on the real upstream calendar
separately (David adds it directly in Google Calendar, or another integration does) —
sync.js then pulls it in as its own `kind: "personal"` (or eventually `"work"`) note,
landing in the same day folder as a note routine already created for what might be the
identical event.

## Desired behavior (David's framing, 2026-09-22)

1. Detect when a routine-owned note and a newly-synced authoritative note plausibly
   describe the same event.
2. Wake `routine` with both records shown side by side.
3. If `routine` is confident they're the same event: keep the authoritative (synced)
   version, merge any notes/content from routine's version into it, then routine may
   delete its own note.
4. If `routine` can't confidently decide: escalate to Lumen (a2a, already wired live
   `routine` → `lumen-dmj`). If Lumen doesn't know either, she asks David directly (her
   own existing approval/DM path — no new mechanism needed for this hop).
5. Mark the routine-owned note with `conflicts-with: [[wikilink-to-the-authoritative-note]]`
   frontmatter once resolved (or once surfaced, TBD which) so the same pair is never
   re-flagged and routine is never woken over it again.
6. Applies to any `kind` pair, not just `personal` — the work calendar (`kind: "work"`,
   not live yet) will need the same treatment once it exists.

## What's already there, free

- a2a routing `routine` → `lumen-dmj` is live and already used (confirmed via delivery
  logs, `docs/roadmap/routine-agent.md`).
- Lumen's own ask-the-human path (approval/DM) already exists — the "Lumen doesn't know,
  asks David" hop needs no new code, just routine's own prompt/persona describing the
  escalation policy.
- `isRoutineOwned`/`kind: "routine"` (from `routine-vault-calendar.md`'s work, now closed)
  already distinguishes routine's own notes from synced ones — the exact predicate a
  detector needs on one side of the comparison.

## Not decided — needs scoping before building

- **Trigger mechanism.** Nothing today diffs routine-owned notes against freshly-synced
  ones. Cheapest fit: fold a comparison pass into (or add alongside) the existing
  stateless calendar-check task series (`docs/roadmap.md`'s `--stateless` scheduled tasks
  item, `roadmap/stateless-scheduled-tasks.md`) rather than inventing a new wake path —
  but not decided which task, or whether a dedicated new series is cleaner.
- **Match heuristic.** A detector should surface cheap *candidates* only (same day,
  overlapping/near time window, one note `kind: "routine"` + the other not) — the actual
  "is this really the same event" judgment call belongs to routine's own reasoning once
  woken with both records shown, not a fragile title/string-match in code. Needs a
  concrete definition of "overlapping/near" (exact time match? ±N minutes? same day
  regardless of time?).
- **Two new tools needed**, neither exists yet:
  - A delete tool for routine-owned notes (`calendar_personal_add`/`edit` exist;
    "cancel via `status: cancelled`" is the only removal path today — David's ask here is
    real deletion, not cancellation, for the confirmed-duplicate case).
  - A way to append content onto an arbitrary *event* note, not just the daily note
    (`daily_note_append` only targets the day's `_index.md`) — needed for "merge routine's
    notes into the authoritative record" before deleting routine's copy.
- **`conflicts-with` marker mechanics.** Goes on the routine-owned note only (matches "never
  re-wake on this pair" — the predicate a detector checks is "routine note lacks
  `conflicts-with`"). Should be set via `obsidian property:set` (single-field), not a full
  frontmatter rewrite via `vault-events.ts`'s current `rewriteEventNote`
  (`create ... overwrite`) approach. Not decided: does the marker get set the moment a
  candidate is surfaced (so routine is never re-woken even before Lumen/David resolve
  it), or only once actually resolved (Lumen/David's answer applied)? The "never re-wake"
  requirement in David's framing reads like the former, but that risks a candidate sitting
  unresolved indefinitely with no second nudge if the first wake's answer never lands.
- **Escalation transport specifics.** "Wake routine and show the conflicting records" —
  as a task wake (`wakeAgent: true` with both records' content in the prompt), or some
  other injection point? Match the existing `wake_script` / stateless-task wake pattern
  (`roadmap/routine-daily-notes.md`, `roadmap/stateless-scheduled-tasks.md`) rather than
  inventing a new one.
- **Generalizing beyond `kind: "personal"` now**, even though the work calendar isn't
  live — so this doesn't need revisiting the moment it lands. Concretely: the detector
  and the two new tools should operate on "any non-routine `kind`" vs. `"routine"`, not
  hardcode `"personal"`.

## Status: not started

Scoped at a "does this make sense" level 2026-09-22; the open questions above need answers
before implementation starts.
