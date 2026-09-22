# `routine` — detect and resolve Routine-added vs. authoritative calendar conflicts

Raised 2026-09-22, right after [routine-vault-calendar.md]'s replacement of the ICS-feed
shims shipped (that item's own file has since been deleted — see `docs/roadmap.md`'s
"Closed 2026-09-22" entry for what it covered). Design decided 2026-09-22; not built yet.

## The problem

`routine` can add its own events to the vault's local calendar copy (`calendar_personal_add`,
`kind: "routine"` frontmatter so the sync pipeline's own staleness sweep never touches
them). Nothing stops the *same* event from also landing on the real upstream calendar
independently (David adds it directly in Google Calendar, or a second integration does) —
sync.js then pulls it in as its own `kind: "personal"` (or eventually `"work"`) note,
landing in the same day folder as a note routine already created for what might be the
identical event. Left alone, both records exist forever with no reconciliation.

## Decided (2026-09-22)

1. **Trigger**: a new dedicated stateless scheduled task (a 5th series alongside routine's
   existing 4 calendar-check series — `docs/roadmap.md`'s `--stateless` scheduled tasks
   item), running hourly (matching sync.js's own hourly `--days=1` cadence — tune later if
   too chatty). Its `--script` gate calls a new **host-shim** (not an agent-facing
   mcp-shim — matches the documented "scheduled-task gate calling a host-shim" pattern in
   `docs/host-shims.md`) that scans for candidate conflicts and returns them as JSON. The
   task script sets `wakeAgent: true` with the candidates embedded in the wake prompt only
   when the scan finds at least one; otherwise `wakeAgent: false`, same as routine's
   existing calendar-check series.
2. **Match heuristic**: the host-shim scan surfaces cheap *candidates* only — same local
   day (group's own timezone), one note `kind: "routine"` lacking `conflicts-with`, another
   note in the same day folder with a different `kind`, and their time ranges either
   overlap or start within 30 minutes of each other. The 30-minute window is a starting
   constant, tunable once this runs against real data. The actual "is this really the same
   event" judgment is routine's own call once woken with both full records shown — the
   scan never tries to decide this itself.
3. **New delete tool — `calendar_personal_delete`** (mcp-shim, agent-facing, routine-owned
   notes only — refuses the same way `calendar_personal_edit` already does): a *soft*
   delete, never destructive. Input: `{path, reason}` (`reason` required — a short
   explanation of why). Behavior:
   - Sets `status: "deleted"` (a new status value, distinct from `"cancelled"` — cancelled
     means "the real event was called off"; deleted means "routine's own record was
     wrong/superseded").
   - Renames the file to `DELETED-<original filename>` (via `obsidian-cli move`).
   - Appends the `reason` to the note's body under a `**Deleted:**` line — never
     overwrites existing body content.
   - **Read-path filters need updating to match**: `vault-events.ts`'s `readDayEvents`
     currently only skips `status === "cancelled"`; it needs to skip `"deleted"` too so a
     soft-deleted note stops appearing in `calendar_personal_today/tomorrow/week`.
   - **Known gap, not blocking**: the vault's own `_index.md` dataview query (in every
     already-created day folder) filters `where status != "cancelled"` only — a `"deleted"`
     note won't be hidden from Obsidian's own native calendar view unless that query is
     also updated. The `DELETED-` filename prefix makes it visually obvious if seen, but
     it will still be *listed*. Fixing this properly means either extending the query text
     used for newly-created `_index.md` files (doesn't retrofit existing days) or teaching
     `readEventNote`-adjacent tooling to patch existing `_index.md` queries too — deferred:
     decide when this tool is actually built, not now.
4. **`conflicts-with` marker**: set on the routine-owned note only, via `obsidian-cli
   property:set` (single-field, not a full frontmatter rewrite), value = a wikilink to the
   authoritative note. **Set the moment a candidate is surfaced** (i.e. as part of the same
   wake that shows routine the pair), not only once actually resolved — this is what makes
   "never woken over it again" true even if the human side of escalation (Lumen → David)
   stalls. Accepted tradeoff: a candidate that gets flagged but never actually resolved
   (nobody answers) won't get a second automatic nudge. Not solving that now; revisit if it
   becomes a real problem in practice.
5. **Generalize past `kind: "personal"` now**, since the work calendar (`kind: "work"`)
   isn't live yet but will need identical treatment. The scan and both new tools key off
   "any `kind` other than `routine`" vs. `"routine"`, never a hardcoded `"personal"` string.

## Still needed, not yet built: merge-append tool

Confirming a duplicate means merging routine's own notes into the *authoritative* note's
body before deleting routine's copy. `calendar_personal_edit` can't be reused for this — it
deliberately refuses to touch anything not owned by routine (that refusal is the whole
point of the ownership check, and stays as-is). A separate tool is needed:

- **`calendar_note_append`** (mcp-shim, agent-facing): appends free text to the *body* of
  any event note by path, routine-owned or not, touching frontmatter not at all. Safe
  against sync.js because sync.js's own upsert patches specific frontmatter fields in
  place and never rewrites the body wholesale (confirmed by reading `sync.js` during the
  original vault-calendar investigation).

## Escalation flow (uses existing infra, no new mechanism)

When woken with a candidate pair, routine sees both records' full frontmatter + body and
decides:
- **Confident duplicate** → `calendar_note_append` routine's notes onto the authoritative
  note, then `calendar_personal_delete` its own note with a `reason` explaining the merge.
- **Not confident** → message Lumen via the existing live `routine` → `lumen-dmj` a2a route
  with both records, asking for a second opinion.
- **Lumen also unsure** → she asks David directly via her own existing approval/DM path.
  No new mechanism needed for this hop — just routine's (and Lumen's) prompt/persona
  needs to describe this policy in prose.

## Tool/asset inventory for the build

New:
- Host-shim: `calendar_conflict_scan` (task-gate only, not agent-facing).
- New stateless task series: hourly conflict check, wired to the host-shim above.
- mcp-shim: `calendar_personal_delete` (soft delete, routine-owned only).
- mcp-shim: `calendar_note_append` (body-only append, any event note).

Changed:
- `vault-events.ts`'s `readDayEvents`: skip `status === "deleted"` alongside `"cancelled"`.
- routine's persona/prompt: describe the escalation policy (confident → merge+delete;
  unsure → ask Lumen; Lumen unsure → ask David) and the `conflicts-with` convention.

Deferred, flagged, not blocking:
- Retrofitting `_index.md`'s dataview query (existing and/or template) to also exclude
  `status: "deleted"` from Obsidian's own native calendar view.

## Status: designed, not built

Take a breath, re-read this, then implement.
