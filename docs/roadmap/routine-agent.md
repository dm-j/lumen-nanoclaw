# `routine` — first non-Dispatcher specialist agent

Decided 2026-09-16: David wants the first real specialist agent (beyond Lumen and the
undescribed `_ping-test` stub) to be `routine` — an agent whose MCP tools manage Lumen's
reminders, plus calendar features. This directly closes the gap flagged in
[dispatcher-agent-infrastructure.md](dispatcher-agent-infrastructure.md)'s "What's still
open": Dispatcher is installed and verified live, but has nothing to actually route to.

## What exists already that this could build on

`mcp-shims/lumen-dmj/` already has both halves of this, currently reachable only from
Lumen's own container:

- `task_management/` — `tasks_capture-host`, `tasks_list-host`, `tasks_finish-host`.
- `calendar/` — `personal_today-host`, `personal_tomorrow-host`, `personal_week-host`
  (plus their shared `ics-events.ts`/`fetch-calendar.ts`/`filter-calendar.ts`/
  `format-event.ts`/`group-timezone.ts` helpers).

Whether `routine` gets its own copies of these shims, or Lumen's `mcp_shims_dir` gets
pointed at a shared directory the way `docs/host-shims.md` describes for the
"obsidian-host vs. obsielian-readonly-host" pattern, is undecided — see "What's still
open" below.

There's also a real, separate scheduling primitive already in the codebase worth not
confusing with "reminders" here: `ncl tasks` (`src/modules/scheduling/`) is NanoClaw's own
cron-backed task system, wired through `cli_scope: group`. If `routine`'s "reminders" are
meant to be NanoClaw-scheduled wake-ups rather than vault-filed to-dos, that's `ncl tasks`
via `cli_scope: group`, not a new MCP shim at all — this needs clarifying before build
starts, since it changes what "manage Lumen's reminders" actually means as a tool surface.

## What's still open

- **Exact tool surface.** "MCP tools that manage Lumen's reminders, plus calendar
  [features]" (message trailed off — confirm the intended scope, don't guess it) — is
  this create/list/finish reminders + read calendar, or does it also need to create
  calendar events, or reschedule/cancel? Matters for how much of the existing
  `task_management`/`calendar` shim set transfers as-is vs. needs new tools.
- **What "reminders" actually means here — unresolved, needs asking, do not assume.**
  Two different things share that name in this codebase: `ncl tasks`
  (`src/modules/scheduling/`, NanoClaw's own cron-backed scheduled wake-ups, reached via
  `cli_scope: group`, not an MCP shim at all) vs. the existing `task_management` mcp-shims
  (`tasks_capture-host`/`tasks_list-host`/`tasks_finish-host`, which are vault/Obsidian
  to-do capture, a different thing entirely despite the similar names). Which one (or
  both) "manage Lumen's reminders" refers to materially changes what gets built —
  `cli_scope: group` for the former, new/moved mcp-shims for the latter.
- **Shim ownership**, once the tool surface is clear. New copies under
  `mcp-shims/routine/`, or a shared/pointed-at directory (see `docs/host-shims.md`'s
  "obsidian-host vs. obsidian-readonly-host" pattern for the precedent)?
- **`description`** for `routine` (item 2's routing-signal convention) — needs the "when
  to route here" framing, e.g. "Use when the request is about a reminder, a scheduled
  task, or checking/managing the calendar."
- **Destinations.** `dispatcher → routine` and `routine → dispatcher` (or `→ parent` if
  `routine` should also report straight back to Lumen the way Dispatcher does) — both
  directions need creating, per the pattern already established for `dispatcher ↔
  lumen-dmj`.
- **`cli_scope`.** Needs `group` for `ncl tasks` reminder management (`disabled` is not
  an option here, unlike Dispatcher, since reminder CRUD is exactly what `group` scope
  grants).
- Once `routine` exists with a real `description` and a destination from Dispatcher, this
  is also the first real exercise of an actual multi-agent delegation chain (Lumen →
  Dispatcher → `routine` → reply), not just the send/reply mechanism check already done.
