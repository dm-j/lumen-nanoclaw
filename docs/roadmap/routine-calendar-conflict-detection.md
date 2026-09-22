# `routine` — detect and resolve Routine-added vs. authoritative calendar conflicts

Raised 2026-09-22, right after [routine-vault-calendar.md]'s replacement of the ICS-feed
shims shipped (that item's own file has since been deleted — see `docs/roadmap.md`'s
"Closed 2026-09-22" entry for what it covered). Design finalized 2026-09-22 across two
rounds of review; not built yet.

## The problem

`routine` can add its own events to the vault's local calendar copy (`calendar_personal_add`,
`kind: "routine"` frontmatter so the sync pipeline's own staleness sweep never touches
them). Nothing stops the *same* event from also landing on the real upstream calendar
independently (David adds it directly in Google Calendar, or a second integration does) —
sync.js then pulls it in as its own `kind: "personal"` (or eventually `"work"`) note,
landing in the same day folder as a note routine already created for what might be the
identical event. Left alone, both records exist forever with no reconciliation.

## Decided (2026-09-22, final)

1. **Trigger — no new task, no host-shim.** David's call: "multiple tasks stepping on
   each other's toes seems like a terrible idea." The scan folds into the existing
   `morning-calendar-digest-a3cc` stateless task (`ncl tasks get --id
   morning-calendar-digest-a3cc --group ag-32059f15-f18a-4505-9d2e-e62b55131587`) as one
   more prompt step, alongside its existing today/tomorrow digest + boop/verify-task
   creation. That task is pure-prompt (no `--script` gate — `has_script: 0`), so the scan
   is a new **agent-facing mcp-shim**, `calendar_conflict_scan`, called directly by the
   agent mid-prompt like `calendar_personal_today` already is — not a host-shim (the
   task-gate/host-shim pattern in `docs/host-shims.md` only applies to `--script`-gated
   tasks, which this isn't). Runs once daily at 6am alongside the existing digest;
   revisit cadence only if real conflicts turn out to need faster catching than that.
2. **Match heuristic — confirmed as originally proposed.** `calendar_conflict_scan`
   surfaces cheap *candidates* only: same local day (group's own timezone), one note
   `kind: "routine"`, another note in the same day folder with a different `kind`, and
   their time ranges either overlap or start within 30 minutes of each other (tunable
   constant). It also skips any routine note whose `conflicts-with` list (see #4) already
   names that specific other note — the actual "is this really the same event" judgment
   is routine's own call once shown both full records, never the scan's.
3. **`_index.md` dataview query — done today, not deferred.** Two changes, both live:
   - Excludes `status: "deleted"` alongside the existing `status: "cancelled"` exclusion
     (needed once `calendar_personal_delete`, below, exists).
   - Switched from `LIST` (shows bare filenames) to `TABLE title as "Event",
     choice(all_day, "(all day)", start_wall + " – " + end_wall) as "Time"` — shows the
     event's actual title and time range instead of its slug-plus-id filename.
   - Updated in both places that generate this query: the vault's own
     `scripts/calendar-sync/refile.js` (`indexContent`, used by `sync.js` for every new
     day folder) and NanoClaw's `mcp-shims/routine/daily_note/shared.ts`
     (`templateContent`, the fallback used when `daily_note_read`/`append` needs to create
     a day's index before sync.js has reached that day) — the two must stay byte-identical
     since either can create a given day's `_index.md` first.
   - **Backfilled all 95 pre-existing `_index.md` files** under `07-Daily/Calendar/` with
     the new query text (a literal, idempotent find-and-replace on the old query string).
     Left the 10 `_series/` master notes alone — different template, out of scope.
   - Also updated `vault-events.ts`'s own `readDayEvents` filter (the JS side, used by
     `calendar_personal_today/tomorrow/week`) to skip `status: "deleted"` alongside
     `"cancelled"` — independent of the dataview query above, since that only affects
     Obsidian's own native view, not NanoClaw's tool output.
4. **`calendar_personal_delete` — soft delete only, never destructive.** David: "I don't
   *delete* data irrevocably if I can help it." Input `{path, reason}` (`reason`
   required). Routine-owned notes only (same ownership refusal as `calendar_personal_edit`).
   Behavior: `status: "deleted"`, filename renamed to `DELETED-<original filename>` (via
   `obsidian-cli move`), and `reason` appended to the note's body under a `**Deleted:**`
   line — never overwrites existing content.
5. **`conflicts-with` is a list, not a single wikilink.** David: "Potentially many, so
   let's make it a list of things it might conflict with. I can try to resolve them
   manually if necessary." Frontmatter becomes `conflicts-with: ["[[note-a]]", "[[note-b]]"]`
   — the scan appends a new entry rather than overwriting, and never re-flags a pair
   already in the list. Set via `obsidian-cli property:set ... type=list` at the moment a
   candidate is surfaced (not at resolution) — matches "never re-wake on the same pair"
   even if the human side of escalation stalls. Accepted tradeoff, unchanged from the
   first design pass: a candidate that's flagged but never actually resolved won't get a
   second automatic nudge on its own.
6. **Generalize past `kind: "personal"` now**, confirmed. The scan and both new tools key
   off "any `kind` other than `routine`" vs. `"routine"`, never a hardcoded `"personal"`
   string — ready for the work calendar (`kind: "work"`, not live yet) without revisiting.

## Still needed, not yet built: merge-append tool

Confirming a duplicate means merging routine's own notes into the *authoritative* note's
body before deleting routine's copy. `calendar_personal_edit` can't be reused for this — it
deliberately refuses to touch anything not owned by routine, and that refusal stays as-is.
A separate tool is needed:

- **`calendar_note_append`** (mcp-shim, agent-facing): appends free text to the *body* of
  any event note by path, routine-owned or not, touching frontmatter not at all. Safe
  against sync.js because sync.js's own upsert patches specific frontmatter fields in
  place and never rewrites the body wholesale (confirmed by reading `sync.js` during the
  original vault-calendar investigation).

## Escalation flow (uses existing infra, no new mechanism)

When the morning digest task's new step finds candidates, it shows routine both records'
full frontmatter + body and routine decides:
- **Confident duplicate** → `calendar_note_append` routine's notes onto the authoritative
  note, then `calendar_personal_delete` its own note with a `reason` explaining the merge.
- **Not confident** → message Lumen via the existing live `routine` → `lumen-dmj` a2a route
  with both records, asking for a second opinion.
- **Lumen also unsure** → she asks David directly via her own existing approval/DM path.
  No new mechanism needed for this hop — just routine's (and Lumen's) prompt/persona
  needs to describe this policy in prose.

## Tool/asset inventory for the build

New:
- mcp-shim: `calendar_conflict_scan` (agent-facing; called as a new step in the existing
  `morning-calendar-digest-a3cc` task's prompt — no new task, no host-shim).
- mcp-shim: `calendar_personal_delete` (soft delete, routine-owned only).
- mcp-shim: `calendar_note_append` (body-only append, any event note).

Changed (done 2026-09-22):
- `_index.md` dataview query (both generators + 95-file backfill) — excludes `"deleted"`,
  shows title + time range instead of filename.
- `vault-events.ts`'s `readDayEvents` — skips `status: "deleted"` alongside `"cancelled"`.

Still to change:
- `morning-calendar-digest-a3cc`'s prompt — add the conflict-scan step.
- routine's persona/prompt — describe the escalation policy (confident → merge+delete;
  unsure → ask Lumen; Lumen unsure → ask David) and the `conflicts-with` list convention.

## Status: designed, ready to build

Two rounds of review done (2026-09-22). Take a breath, re-read this, then implement.
