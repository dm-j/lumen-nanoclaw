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

## Status: shim built and verified; not yet wired to Routine

What's landed: `daily_note` read/append shims exist under `mcp-shims/routine/`.
`discoverMcpShims` picks them up automatically at Routine's next container spawn (no
action needed there). What's still open:

- **Not yet exercised by `routine` itself** — no live agent turn has called either tool
  yet, only direct CLI invocation during build.
- **The actual `--wake-script` on `routine`'s container config and scheduled task(s)** —
  the one-liner that calls `host-shim daily_note read` at wake time and emits
  `{"wakeAgent": true, "data": "<contents>"}`, closing the loop with the mechanism built
  earlier today. Not set yet.
- **`wake_script` live-update timing not yet separately verified** — `container.json` is
  only re-materialized at container spawn (per `materializeContainerJson`'s doc comment),
  so a `--wake-script` set via `ncl groups config update` needs `routine`'s container to
  at least respawn before it takes effect, same as any other `container.json` field. Not
  confirmed in practice yet since no wake-script value has been set.
