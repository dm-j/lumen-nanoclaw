# `routine` — daily-note awareness

Discussed 2026-09-17/18: David wants `routine` to be able to see (and write to) "today's"
note in his Obsidian vault, `07-Daily/{YYYY}/{MM}/{DD}.md`, without relying on the agent
remembering to fetch it.

## Why not the two obvious naive approaches

- **Bake today's content into `instructions.prepend.md` via a daily cron.** Standing
  instructions only take effect after a container restart (`container/CLAUDE.md`), so this
  needs a cron that edits the file *and* restarts `routine`'s container once a day. It also
  goes stale the moment the note changes again later that day — the prompt doesn't
  re-read it mid-session.
- **Give `routine` a shim tool and trust it to call it.** Rejected outright by David:
  "the agent *remembering* to check it is pretty much a non-starter."

## The actual plan: reuse the existing pre-task-script mechanism

`applyPreTaskScripts` (`container/agent-runner/src/scheduling/task-script.ts:84`) already
runs a script at wake time for `kind: 'task'` messages and folds its stdout into that
turn's prompt via `scriptOutput` — a synthetic injected message, exactly what David asked
for ("could I add a synthetic call to fetch the day's notes?"), and it already exists.
Tasks carry this via the `script` column (`src/modules/scheduling/create.ts:31`), settable
with `ncl tasks create/update --script`.

Two pieces:

1. **One MCP shim, not two.** `daily_note(action: read|append|write)` — resolves
   `07-Daily/{YYYY}/{MM}/{DD}.md` off the group's own effective timezone
   (`resolveGroupTimezone`), creates it from a template on first touch if missing. This is
   what `routine` calls when it wants to *edit* the note mid-session (log something,
   append a task).
2. **A `--script` on `routine`'s scheduled task(s)**, run every wake: resolve today's path
   the same way, create-from-template if absent, print `{"wakeAgent": true, "data":
   "<file contents>"}`. Zero new host plumbing — this is the existing contract
   `runScript`/`applyPreTaskScripts` already expects.

## The a2a gap — resolved 2026-09-18

`applyPreTaskScripts` only fires for `messages_in` rows with `kind === 'task'`. David
confirmed `routine` only ever wakes two ways: Dispatcher's `assign_task` (a dedicated
per-task a2a session — see [task-id-routing-spike.md](task-id-routing-spike.md)) or a
scheduled task. The `--script` mechanism only covered the second path — an
`assign_task`-created session's opening message is an a2a `chat`-kind row, not
`task`-kind, so `applyPreTaskScripts` never saw it.

Resolved by adding a wake-level hook that sits above both trigger kinds, rather than
extending the task-specific one: a new `container_configs.wake_script` column (migration
034), materialized into `container.json` as `wakeScript`, run once at the very start of
every wake in `poll-loop.ts` — before `formatMessagesWithCommands` builds the prompt,
regardless of whether the triggering row was `task`-kind or an a2a `chat`-kind row. Same
contract as a task's own `--script` (last stdout line is JSON `{wakeAgent, data?}`), but
its `data` is rendered as a `<wake-context>` block prepended to the prompt rather than
mutated onto one message's content, since there's no host-provided task message to attach
to on the a2a path. Confirmed the underlying `runScript`/JSON-stdout contract can reach
the vault: `mcp-shims`/`host-shims` are invoked from inside the container via the
`host-shim <name> [args...]` binary (`container/agent-runner/src/cli/host-shim.ts`), a
plain DB-transport CLI on `PATH` — a bash wake-script can call `host-shim daily_note read`
directly, same as the agent's own tool calls would.

Set via `ncl groups config update --id <group> --wake-script '<bash>'`; `""` clears it.
One script covers both of `routine`'s wake paths uniformly — no message-kind branching,
no "is this a fresh session" detection needed.

Landed on `routine-daily-notes` branch, 2026-09-18: migration 034
(`src/db/migrations/034-wake-script.ts`), `container_configs`/CLI/container.json
plumbing, and the `poll-loop.ts` injection point. Host typecheck, container typecheck, and
both affected test suites (`src/db/db-v2.test.ts`, `src/modules/host-shim/exec.test.ts`,
`src/cli/resources/groups.test.ts`, `container/agent-runner/src/poll-loop.test.ts`) all
green.

## `daily_note` shim — built 2026-09-18

Real vault path corrected during build: David's "07-Daily/{YYYY}/{MM}/{DD}.md" and
"Calenday" were both approximations — `obsidian folders folder="07-Daily"` against the
live vault showed the actual convention already in use by an existing calendar-sync
pipeline is `07-Daily/Calendar/{YYYY}/{MM}/{DD}/_index.md` (a *folder* per day, containing
`_index.md` plus one sibling file per calendar event). `_index.md`'s real shape (checked
live against several existing days) is a dataview query, not a journal note — Obsidian's
own separate "Daily Note" template (`00-Inbox/{date}.md`, checked via `daily:path`) is a
different, unrelated feature and was not used.

Uses the `obsidian` CLI (`/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`,
vault `lumen-data`) exactly as the existing `mcp-shims/lumen-dmj/vault/*` shims already do
— `read`/`create ... overwrite`/`append` against an exact `path=`. Confirmed live:
`content=` values pass through fine as real newline bytes via `execFileSync` (no shell
involved), no manual `\n`-escaping needed despite the CLI's own `--help` text suggesting
otherwise (that instruction is for its literal terminal invocation, not for a
programmatic caller passing real argv strings).

Two tools, not a single multi-action one (matches the existing `calendar/personal_*`
convention — separate tool per verb, clearer for model routing than an action enum):

- `mcp-shims/routine/daily_note/read.ts` (+ `read-host`) — returns today's `_index.md`,
  creating it from the same template the calendar-sync pipeline already uses if this day
  hasn't been reached yet.
- `mcp-shims/routine/daily_note/append.ts` (+ `append-host`) — appends caller-supplied
  content, same ensure-exists-first behavior.
- `shared.ts` — `obsidian` exec wrapper, tz-aware date-part resolution (via the sibling
  `calendar/group-timezone.ts`, same hardcoded `routine` agent-group id used by the
  calendar shims), the template string, and `ensureDailyNote`.

Deliberately **no full-overwrite ("write") action** — `ponytail:` the existing
`_index.md` files are populated by another automated pipeline (the dataview block +
sibling event files); a blind overwrite tool risked an agent nuking that structure by
accident. `append` covers the "editing" need David asked for; add a scoped edit action
(e.g. replace-just-the-Notes-section) if that turns out to be needed later.

Verified live end-to-end against the real vault: `--help` schemas correct, `read-host`
returned today's real note, `append-host` appended a test line and it round-tripped
correctly on the next read — then reverted via `create ... overwrite` back to the
pre-test content (today's note is calendar-pipeline-owned; the test line wasn't left in).

## Wired and verified live — 2026-09-18

`--wake-script` set on `routine`'s container config: a `/bin/sh` script that calls
`host-shim daily_note/read`, captures its stdout into an env var, and uses `node -e` to
build the `{"wakeAgent": true, "data": "..."}` envelope (avoids manual JSON-escaping —
`WAKE_NOTE_CONTENT="$CONTENT" node -e '...JSON.stringify(...process.env...)'`). Live-fire
tested by manually triggering a scheduled task run (`ncl tasks run`) and by a purpose-
built one-shot diagnostic task asking `routine` to quote back everything that preceded
its actual prompt verbatim — confirmed via the raw a2a message content in Dispatcher's
`inbound.db` (not just `routine`'s own summary of what it did) that the exact `_index.md`
content arrived as a `<wake-context>` block, and that `routine` completed its actual
assigned task normally afterward (no breakage to normal operation). `wake_script`
live-update timing confirmed in practice: no separate container restart ceremony was
needed beyond the respawn that already happens between wakes.

One real defect found from that same live test, fixed same day: the `<wake-context>`
content was the **literal, unrendered `dataview` query source** (`dataview` blocks only
render inside Obsidian's own UI — a plain file read returns the query text, not results).
Worse than useless — could be mistaken for real event data. Fixed in
`shared.ts`'s `stripDataviewBlocks`: strips the template's paired `# Events` heading +
dataview block together (so a note with nothing else in it isn't left with an orphaned,
contentless heading), with a second bare-dataview-block pass as a fallback. Calendar data
has its own dedicated tools (`calendar_personal_*`) anyway — the daily note was never the
right place for it to also live.

`daily_note_read`/`daily_note_append` both extended with an optional `day` parameter
(`"today"` default, `"yesterday"`, `"tomorrow"`, a case-insensitive weekday name —
**always** the next occurrence that hasn't happened yet, never today or a past one even
if today matches — or an exact `"YYYY-MM-DD"`). `append` deliberately extended to
future days too, on David's reasoning: a note left on a future day today is a legitimate
"my routine" pattern (leave yourself something that becomes part of that day's note when
it arrives), so restricting `append` to today-only (my original suggestion) would have
cut a use case David actually wanted. Tool descriptions and `routine`'s
`instructions.prepend.md` were also reworded to say a note "always exists" rather than
exposing the create-on-demand implementation detail — from `routine`'s perspective that
distinction shouldn't matter.

Landed in two commits on `routine-daily-notes` (delivery.ts transcript-recipient fix
split out separately, unrelated to this feature but found/fixed in the same session):
`fix: fall back to session's messaging group when a delivered chat message has no
platform_id`, `feat: per-agent-group wake_script, unconditional on trigger kind`.

## Future ideas — not scoped, captured 2026-09-18 so they aren't lost

David, thinking out loud (not requesting either be built yet):

- **Fold the daily note into Lumen's own briefing.** Lumen's briefing compiler
  (`src/modules/projected-sessions/compile-briefing.ts`) already runs a host-side step
  before Lumen wakes — structurally the same shape of problem `routine`'s wake-script
  just solved, just a different injection point/consumer. Two different amounts of work
  hide under "include the daily note": (a) mechanically concatenate the same raw content
  routine sees, cheap, same pattern as this doc; or (b) have the briefing compiler (or a
  dedicated "briefer" step) *read the note and selectively incorporate* pertinent
  content, which means giving that step actual judgment about relevance, not just
  injection — a materially bigger scope than (a). Needs deciding which one before
  building either.
- **Let `routine` edit existing note content, not just append.** David's framing: "not
  every note is permanently true... a note that is true in the morning might not be in
  the afternoon" — an edit-text-tool-style capability (possibly a wrapped `obsidian`
  invocation using its own `property:set`/targeted-edit commands rather than a blind
  find-and-replace). This directly reopens the tension the no-overwrite decision above
  was made to avoid: the note's `# Events`/dataview section is pipeline-owned, and a
  generic edit tool risks an agent corrupting that structure. Whatever gets built needs
  an explicit boundary — e.g. scoped to a `## Notes` section only, never touching
  frontmatter or the dataview block — decided as part of the design, not assumed safe by
  default.

## Addendum 2026-09-23 — ID'd `## Notes` block and `notes_*` tools (built)

Answers the second future idea above. Decided with David:

- **Where.** Every day's `_index.md` gets a `## Notes` heading plus an Obsidian quote block
  whose block ID is `^daily-notes` (ID on its own line after a blank line). The template lives in
  `mcp-shims/routine/daily_note/shared.ts` (`sync.js` never creates `_index.md`), so new days get it
  from there and `notes_*` insert the block if it is missing. Only 32 `_index.md` files existed, so no
  migration was written; old days self-heal on first `notes_*` call.
- **One note = one list item with its own block ID:** `> - 09:14 routine: text ^n3f9k2`. Chosen over
  literally nested quotes because Obsidian supports block IDs on list items natively and nested-quote
  ID placement is ambiguous. Multi-line notes indent continuation lines; the ID ends the last line.
- **Tools** (`mcp-shims/routine/notes/`): `notes_read`, `notes_add`, `notes_edit`, `notes_delete`,
  all by ID, all with an optional `day`. The shim adds/strips the `> ` prefixes and prefixes each written note
  with `HH:MM routine:` so agents only see plain text. No text-match or line-number addressing.
- **Hand-typed notes** without an ID are listed as `[?]` and never edited or dropped; David adds an ID
  himself (keyboard smash) if he wants one addressable. **Duplicate IDs** in one block (should never
  happen): the alphabetically-last note by text gets a fresh ID, on any `notes_*` call.
- **Tolerant IDs (David, same day).** Input IDs are trimmed, stripped of surrounding `[brackets]`
  (agents echo them from `notes_read`), and lowercased; matching is case-insensitive everywhere
  (a hand-typed `^SMASH1` is addressable as `smash1`; duplicate detection and fresh-ID collision checks
  are case-insensitive too). An ID that is not exactly 6 characters is rejected before any vault access.
  Consequence: hand-typed IDs must be 6 characters to be addressable.
- **Safety.** Logic is confined to the block; nothing outside it is ever rewritten. Writes are
  compare-and-write (re-read, refuse if the note changed under us). Verified live on scratch days
  (2030-01-01/02, since deleted): add, multi-line, read, edit, delete, bad ID, text outside the block
  preserved, template-created day. Pure logic has `notes-block.selftest.ts`.

**Still open:**
- **Hand-off to the vault project's Claude:** `scripts/calendar-sync/refile.js` (~line 120) deletes a
  day folder that holds only `_index.md`, which would now destroy stored notes. It must keep the
  folder if the notes block is non-empty.
- **Switch Routine's `wake_script` to `notes_read`** (injects only the notes, not the whole note) —
  not done; the existing wake-script still injects the whole stripped note, which now includes the raw
  quote block with IDs.
- **Lumen:** her own copy of the `notes` shims (`WHO = "lumen"`, her group's timezone) via a shared
  code directory, plus injecting the notes into her briefing (`compile-briefing.ts`), capped at ~4k chars.
- **Size cap** on the injected notes text is not implemented yet.

### Wake script switched to the notes block — 2026-09-23

Routine's `wake_script` no longer injects the whole stripped daily note; it injects today's date plus just the `## Notes`
block (`host-shim notes/read`, so each note shows as `[id] text`, or `(no notes)`), with a one-line pointer to
`notes_edit`/`notes_delete`. The date line replaces the grounding the note's frontmatter (`date`, `day_of_week`) used to give.
Set with `ncl groups config update --id ag-32059f15-f18a-4505-9d2e-e62b55131587 --wake-script ...`; the new script was
tested on the host against a stand-in `host-shim`, then verified live with a diagnostic one-shot task (see below).
**Rollback** (previous script, whole-note injection):

```sh
#!/bin/sh
CONTENT="$(host-shim daily_note/read 2>&1)"
WAKE_NOTE_CONTENT="$CONTENT" node -e "console.log(JSON.stringify({wakeAgent:true,data:process.env.WAKE_NOTE_CONTENT||\"\"}))"
```

Side effect worth knowing: `notes_read` on a day whose `_index.md` has no `## Notes` block inserts the empty block, so the
first wake of a day adds it to that day's note (the same self-heal every `notes_*` call does).

### Lumen's notes tools, capped injection, calendar labels — 2026-09-23

- **Lumen has `notes_read/add/edit/delete`** (`mcp-shims/lumen-dmj/notes/`), the same code as Routine's: the wrappers set
  `NOTES_GROUP_ID` (her timezone) and `NOTES_WHO=lumen`, so her notes are stamped `HH:MM lumen:`. `notes.ts` now reads both
  from the environment, defaulting to Routine's. Her persona (`groups/lumen-dmj/instructions.prepend.md`) has a short
  "Daily Notes" section.
- **Injection for Lumen uses the same `wake_script` as Routine**, not a briefing-compiler change: the wake script runs inside the
  agent-runner poll loop once per batch of messages and is prepended to that turn's prompt, so the notes are fresh on every turn
  ("her latest turn's briefing" in effect) with no host code. Both groups' scripts now **cap the injected notes at 4000
  characters** (appending "[...truncated: use notes_read for the full list]"). The capped script was verified on the host against
  stand-ins for `host-shim` (oversized list, empty list, and against Lumen's real wrapper); the mechanism itself was verified live
  on Routine earlier the same day. Lumen was not woken to test it (no running container at the time, and a night-time
  diagnostic could message David); her next message spawns a container with the new tools, script and instructions.
  Cost note: each turn now runs one extra `host-shim notes/read` (an obsidian CLI read, well under a second).
- **Calendar labels (Routine).** `calendar_personal_today/tomorrow/week` now label each event with its note's `kind`
  (`personal`, `work` or `routine`) instead of always `personal`; the tool names are unchanged so scheduled tasks that call
  them keep working, but their output now includes work events. Their descriptions say so, and Routine's
  `instructions.prepend.md` was rewritten to describe the calendar (personal + work, labelled; real synced events read-only,
  own events addable/editable) and the `notes_*` tools accurately. Verified: the week view returned 25 events, 13 personal and 12 work.

### Weekday abbreviations — 2026-09-23

The shared `resolveDay` (`mcp-shims/routine/daily_note/shared.ts`, used by `daily_note_*` and every `notes_*` tool for both
Routine and Lumen) also accepts common weekday abbreviations, case-insensitive with an optional trailing period: `sun`, `mon`,
`tue`/`tues`, `wed`/`weds`, `thu`/`thur`/`thurs`, `fri`, `sat`. They mean exactly what the full name means: always the next
occurrence, never today or a past day. Checked by `daily_note/day.selftest.ts` (compares each abbreviation to its full name,
so it does not depend on the date) and through the real `daily_note_read` wrapper (`Fri` -> 2026-09-25, `thurs.` -> 2026-09-24).
The tool `day` parameter descriptions still say "a weekday name"; abbreviations are accepted silently.
