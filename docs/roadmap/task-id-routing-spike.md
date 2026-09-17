# Task-ID routing spike (`AssignTask`)

Branch: `spike/task-id-routing`. Planning spike, no implementation yet —
started 2026-09-16 to resolve the open design questions on
[transient-session-mode.md](transient-session-mode.md) and the shared
intermediate-data-folder idea (see "Addendum" note below), after the
session-heuristic fix (peer-affinity fallback) turned out to be the wrong
level to solve this at.

## The problem this replaces

`resolveTargetSession` (`src/modules/agent-to-agent/agent-route.ts:209`)
picks which session of a target agent group receives an a2a message via
three layers: (1) `in_reply_to` → `source_session_id` lookup — exact and
correct for a reply within an open exchange; (2) peer-affinity — "whatever
session this peer last used," which is *too* sticky: a genuinely new,
unrelated task from Lumen still lands in Dispatcher's one long-lived
session, because the fallback can't tell "new task" from "no reply
metadata available." (3) newest-active-session, same problem.

Layer (1) already gives correct clarification behavior for free — a
Dispatcher clarifying question, replied to, lands back in the exact
session that asked. The bug is purely in (2)/(3): unrelated fresh tasks
keep reusing old sessions, so Dispatcher's context grows unbounded across
its whole lifetime instead of being scoped to one task.

An earlier fix idea (a `transient` session_mode that mints a fresh session
whenever (1) misses) would have worked but is purely inferred/implicit —
it can't represent Dispatcher decomposing one request into several
parallel sub-tasks, each independently tracked. `AssignTask` makes the
task boundary explicit and model-driven instead, and (per the discussion
that led here) subsumes the transient-mode fix as its fallback case.

## The mapping: task_id is a thread_id, not a new concept

Sessions are already keyed by `(agent_group_id, messaging_group_id,
thread_id)`. Scheduled tasks already use exactly this pattern today,
unrelated to a2a: `resolveTaskSession(agentGroupId, seriesId)`
(`src/session-manager.ts:137`) resolves a session keyed on
`taskThreadId(seriesId) = "system:tasks:<seriesId>"`
(`src/db/sessions.ts:90`), found via `findSystemSession(agentGroupId,
threadId)` (`src/db/sessions.ts:75` — `messaging_group_id IS NULL`, exact
thread_id match).

`AssignTask`-originated a2a sessions should reuse this exact pattern with
a distinct thread-id namespace, e.g. `a2aTaskThreadId(taskId) =
"system:a2a-task:<taskId>"`, and a new `resolveA2aTaskSession(agentGroupId,
taskId)` that's a near copy of `resolveTaskSession`. No new DB column,
no new table for the session side — the `sessions` table already supports
this key shape.

## Proposed shape

**New tool**: `mcp__nanoclaw__assign_task({ to, task })` → `{ task_id }`.
Mints a fresh id (same style as `a2aMsgId` generation), does not by itself
deliver anything — it just reserves the identity a subsequent
`send_message` will use.

**`send_message` gains an optional `task_id`.** When present:
- Target session resolution skips straight to
  `resolveA2aTaskSession(targetAgentGroupId, task_id)` — bypasses the
  sticky peer-affinity fallback entirely for this send.
- The outbound content also carries `task_id`, threaded onto the inbound
  row the same way `source_session_id` already is, so the repeat-loop and
  pair-message-streak checks in `agent-route.ts` (both already
  session-scoped) get an even tighter natural scope — a runaway loop
  within one task can't quietly reset by virtue of the task itself
  spanning many messages, since each task already has its own session.

**Decomposition**: Dispatcher calls `assign_task` once per sub-task it
delegates (to Routine, to Computation, to a fresh specialist), gets back
`task_id_a`, `task_id_b`, etc., and `send_message`s each with its own
`task_id`. Each delegate gets its own dedicated session for that one
sub-task — never shares context across unrelated sub-tasks even from the
same parent request. Dispatcher's own session for the *parent* task
(assigned to it by Lumen) is a separate, third `task_id` — its own
`resolveA2aTaskSession` entry — so Dispatcher's parent-task context and
each sub-task's delegate context are all independently scoped and
independently done-when-they're-done.

**Fallback for a forgetful agent** (no `assign_task` called, no `task_id`
passed): layer (1) still gets first shot — an actual reply keeps working
correctly with zero tool discipline required. Only when (1) misses *and*
no explicit `task_id` was given does the host mint an implicit one
automatically (same `resolveA2aTaskSession`, host-generated id) instead of
falling through to the old sticky peer-affinity/newest-session fallback.
This is the safety net: a "less bright" agent that never calls
`assign_task` still gets a fresh, bounded session per apparent new task,
it just doesn't get the *decomposition* benefit (every sub-message it
sends without a `task_id` mints its own new implicit task rather than
sharing one).

## Ties into the shared-folder idea

The earlier "shared symlinked folder for intermediate files" discussion
stalled on what to key the folder name on — session id doesn't work
(long-lived, never archivable), per-a2a-message id doesn't span a whole
exchange. `task_id` is exactly the right key: `data/shared-tasks/<task_id>/`,
bind-mounted into every container that's a party to that task (source +
target, and any further sub-task delegates whose parent chain traces back
to it), archived by the nightly sweep once the task's session(s) close.
Should be designed together with this, not separately — same underlying
unit of work.

## Open questions for actual implementation (not resolved in this spike)

- **Task lifecycle / closure**: what marks a task "done" so its session(s)
  can be archived and its shared folder swept? `report_completion`
  (`container/agent-runner/src/mcp-tools/core.ts`, added 2026-09-16 for the
  ack-loop fix) is a strong candidate for the actual closure signal, not
  just a routing nicety — it's already the structurally-marked "this is my
  final word on this work order" message a worker sends, so the host could
  treat delivery of a `report_completion` call carrying a given `task_id`
  as the trigger to close that task's session(s) and archive its shared
  folder, rather than inferring closure from session idleness. Still needs
  the decomposition-tree case worked out — a parent task isn't done until
  all its sub-tasks report back, so closure likely still wants a small
  ledger table (`agent_tasks`: id, parent_task_id, assigner_group_id,
  assignee_group_id, status, created_at, closed_at) that `report_completion`
  writes to, rather than the tool being the entire mechanism by itself.
- **Staleness detection (2026-09-16 addendum)**: separately from closure,
  David raised tracking an explicit `WORKING` state (behavior-tree
  convention) so the host can flag a task session that's been outstanding
  too long with no `report_completion` — a stuck/abandoned delegation, not
  just a loop. Landed same day: `sessions.status` is a plain `TEXT` column
  (no DB constraint) but the TS type is a strict `'active' | 'closed'`
  binary, and routing code (`findSessionByAgentGroup`'s SQL filter,
  `resolveTargetSession`'s candidate check, the new `closedSession` check)
  all hardcode `status === 'active'` as "is this session usable." Adding a
  third value to that same column would silently break every one of those.
  Cleaner: a separate `work_status` column/field (`'working' | null`),
  orthogonal to `status` — `status` keeps its existing lifecycle meaning,
  `work_status` is the new layer. Set `'working'` when a delegated task
  session is created (ties into the `agent_tasks` ledger above — probably
  belongs on that table, not on `sessions`, once it exists), cleared when
  `report_completion` closes it. A sweep mirroring `host-sweep.ts`'s
  existing "close spent task session" pass could then flag anything still
  `working` past a threshold. Not built — needs the `agent_tasks` ledger
  decided first, since this is really a field on that table.
- **Observability**: should `ncl` grow a `tasks` (or `agent-tasks`, to not
  collide with the existing scheduled-`tasks` resource) list/get surface
  for live a2a task delegations, mirroring `ncl tasks list`? Useful for
  debugging a stuck decomposition tree.
- **Guard/approval interaction**: `routeAgentMessage`'s existing
  `agent_message_policies` hold/approve flow (`message-gate.ts`) needs to
  carry `task_id` through the approval payload so an approved replay still
  resolves to the right session — currently payload only carries
  `platform_id`/`content`/`in_reply_to`.
- **Does every agent group need this, or just Dispatcher-shaped ones?**
  Routine and Computation already get natural session isolation from
  their own task-series-per-series-id model (scheduled tasks) or don't
  accumulate meaningfully. This may only matter for agents that *receive*
  free-form a2a delegation as their primary mode (Dispatcher today; Travel
  later, per travel-agent-leave-now.md).
- **Interaction with `agent_message_policies` approval gate content limit**
  (`GATE_CARD_BODY_MAX`) — no change needed, just confirm `task_id`
  doesn't need to appear in the human-facing approval card text.
