# `--stateless` scheduled tasks — shipped 2026-09-16

Raised while discussing `assign_task`: a scheduled task series (`ncl tasks
create --recurrence ...`) reuses the *same* dedicated session forever,
across every fire — unlike a2a work (now solved by `assign_task`'s
per-work-order sessions), there was no way to tell a recurring task its
work is fully self-contained each run and it doesn't need its prior
transcript. The existing generic safety net (every session's transcript
rotates at 12MB/14 days, `container/agent-runner/src/providers/claude.ts`)
bounds this, but a task like a 3x-daily calendar digest still pays to
resume up to two weeks of dead weight before that cap ever fires.

## What's live

- `ncl tasks create --stateless` / `ncl tasks update --stateless` — stored
  as `content.stateless: true` on the task row (no schema change needed;
  task metadata already lives in `messages_in.content` JSON, not a
  dedicated table). `insertRecurrence` already copies `content` verbatim to
  every future fire, so this persists across the whole series automatically.
- Host (`src/container-runner.ts`'s `syncStatelessMarker`, called from
  `spawnContainer`): on every wake of a task-thread session, reads the most
  recent task row's `content.stateless` and writes/removes a per-session
  marker file (`<sessionDir>/.task-stateless`) accordingly.
- Container (`container/agent-runner/src/stateless-session.ts` +
  `poll-loop.ts`): when the marker is present, the continuation is never
  read, resumed, rotated, or persisted — same treatment as a
  projected-lifecycle session's continuation handling, but without a
  compiled-briefing replacement (there isn't one; the task's own prompt
  each fire is the whole context).
- Routine's four live calendar-check task series
  (`morning-calendar-digest`, `midday-calendar-check`,
  `evening-calendar-check`, `weekly-calendar-lookahead`) flipped
  `--stateless true` the same day — verified live: marker file present
  inside the spawned container, no "Resuming agent session" log line, and
  the previously-stored continuation in `session_state` left untouched
  (never overwritten) after a fresh run.
- Routine's standing instructions (`groups/routine/instructions.prepend.md`)
  now explain when to reach for `--stateless` on tasks it creates itself.

## Not built / open

- Only Routine's instructions mention `--stateless` explicitly — other
  agent groups (Computation, any future scheduler-using agent) would need
  the same instruction added if they start creating their own recurring
  tasks with genuinely stateless work.
- No `ncl tasks get`/`list` surfacing of the `stateless` flag in its
  default output — has to be inferred by reading `content` or the marker
  file today.
- Doesn't touch a2a `assign_task` sessions — those already get "no resume"
  behavior for free by virtue of being fresh every time (a new session per
  work order, never reused), so there was nothing to add there. This item
  is specifically about the *scheduled*-task case, where the session *is*
  reused across every fire by design.
