# `routine` — first non-Dispatcher specialist agent

Decided 2026-09-16: David wants the first real specialist agent (beyond Lumen and the
undescribed `_ping-test` stub) to be `routine` — an agent whose MCP tools manage Lumen's
reminders, plus calendar features. This directly closes the gap flagged in
[dispatcher-agent-infrastructure.md](dispatcher-agent-infrastructure.md)'s "What's still
open": Dispatcher is installed and verified live, but has nothing to actually route to.

## Why (the actual long-term goal, not just "give Dispatcher something to route to")

David's stated end state: eventually remove tools from Lumen herself and have her delegate
to her "Crew" (Dispatcher + specialists like `routine`) instead — so Lumen concentrates on
*what* needs doing, not *who* should do it or *how*. `routine` is the first concrete step
toward that, not just a test fixture for Dispatcher's plumbing: reminders and calendar are
a reasonable first thing to peel off Lumen because the tool surface already exists
(`mcp-shims/lumen-dmj/task_management/` and `calendar/`) and is self-contained enough to
relocate without a redesign.

This means the eventual shape isn't just "add `routine` alongside Lumen's existing tools"
— it's "add `routine`, then remove the equivalent tools from Lumen's own container config
once `routine` covers the same ground and Dispatcher can route to it reliably." That
removal step isn't scoped yet (no plan for *which* of Lumen's current mcp-shims move
first, in what order, or how to avoid a gap where neither Lumen nor `routine` can serve a
request mid-migration) — worth its own discussion once `routine` actually exists and has
been exercised for real, not decided speculatively now.

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

## Status: built 2026-09-16

Agent group created (`ag-32059f15-f18a-4505-9d2e-e62b55131587`), `cli_scope: group` (for
`ncl tasks` reminders), `model: role/cheap-worker`, `description` set, destinations wired
both directions with Dispatcher. Calendar shims copied from `lumen-dmj` to
`mcp-shims/routine/calendar/` (read-only, `personal_today`/`tomorrow`/`week`) with the
hardcoded timezone-lookup agent-group id repointed at `routine`'s own id. Prompt written
at `groups/routine/instructions.prepend.md` — lean specialist shape (bounded domain,
mandatory reply, scope discipline), not Dispatcher's full coordinator scaffolding.

Live-tested via a direct Dispatcher → routine work order: the a2a chain worked correctly
end to end (session created, message routed, `routine` replied, reply routed back). The
test also surfaced a real, systemic issue unrelated to `routine`'s own setup: every agent
container's `TOOL_ALLOWLIST` included `Task`/`TeamCreate` (same-session subagent
dispatch), which doesn't inherit the container's routed model and fails against real
Anthropic via OneCLI — hit independently on both Dispatcher and `routine`. Fixed the same
day in `container/agent-runner/src/providers/claude.ts` (moved to
`SDK_DISALLOWED_TOOLS`, same treatment already given `SendMessage` for the same category
of problem), image rebuilt, verified live. `routine` is now both correctly wired and safe
to rely on.

## Addendum 2026-09-16 (2): two more real bugs found chasing the same test

Getting `routine` to that "correctly wired" state took two more genuine fixes, both found
by actually retrying the same "what's on my calendar" request repeatedly rather than
declaring victory on the first mechanically-correct-looking exchange:

1. **Missing `env`/`blockedHosts` on `routine`'s `container.json`.** `ncl groups create`
   (unlike the `create_agent` MCP tool, which inherits its spawning parent's env) never
   seeded these — `routine` had been hitting real `api.anthropic.com` via OneCLI on every
   single turn since creation, immediately misdiagnosed as the `Task`-tool gap above
   (that fix was real and stays; it just wasn't what caused this). Fixed generically in
   `materializeContainerJson` — see the roadmap's main log for the commit.
2. **`role/cheap-worker` (gpt-oss-120b) narrated tool use instead of performing it** —
   said "Fetching today's calendar events…" and stopped, no actual tool call. Switched
   `routine` to a new `role/medium-worker` alias (glm-5.3-flash:cloud) added to
   PrefixRouter for this; it called the tool correctly.

Even after both of those, the *first* clean end-to-end run's answer was still wrong: it
correctly delegated, correctly called `calendar_personal_today`, and correctly reported
back — "no events today" — when there were three. That one wasn't an agent-wiring problem
at all: a real bug in `fetch-calendar.ts` (`mcp-shims/routine/calendar/`), where a
modified single occurrence of a recurring calendar series (Google: retitle/reschedule one
instance without touching the series) is nested under the *master* event's `.recurrences`
map by node-ical, invisible to a flat top-level read. Fixed (also ported to `lumen-dmj`'s
identical copy, same latent bug there). The other two "missing" events genuinely were
missing too, for the separately pre-existing, previously-deferred reason: unmodified
future occurrences of an ongoing weekly series were never expanded at all (a `ponytail:`
comment had documented this gap before tonight). David asked for that expansion to be
built rather than left deferred, once it was clear it wasn't hypothetical — real recurring
events were actually going missing. Implemented via node-ical's attached `rrule.between()`
per master event, bounded to the query's own date range (unbounded expansion of an old/
infinite series is unsafe otherwise). One real bug surfaced building *that*: an
override's "this date is already covered" tracking was scoped globally instead of
per-series, so one series' override incorrectly suppressed an unrelated series' real
occurrence landing on the same calendar date — caught by checking the full week's output
against a second known event before trusting the first fix, not just the one event that
prompted it. All three of today's real events (the override, and both recurring classes)
now show correctly, on both copies.

**The lesson, not just the bugs**: "the mechanism produced a plausible, well-formed
answer" and "the answer was correct" are different claims — this took retrying the exact
same real request three more times after it looked done to find that out, and a second
verification pass (a different day's worth of events) to catch the fix's own bug too.
