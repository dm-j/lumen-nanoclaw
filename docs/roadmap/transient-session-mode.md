# A 4th `session_mode`: `transient` (task agents, no carried-over history)

Decided 2026-09-16, while debugging why Dispatcher deflected instead of retrying a
delegation to `routine`: its session history had accumulated an entire night's worth of
401s, confused troubleshooting, and prior failed attempts, and it was reasoning from that
polluted transcript instead of the current, now-fixed state of the world.

## The distinction that matters

Two different things got conflated during the discussion and need to stay separate:

- **Projected sessions** (`src/modules/projected-sessions/`, already built, already used
  by Lumen) — synthesizes a *compressed but continuous* memory: a compiled briefing plus
  a short literal tail, replacing an ever-growing raw transcript resume. The point is
  **compression with continuity** — Lumen still remembers yesterday, just not by replaying
  every token of it. This is the right model for an agent with an ongoing relationship to
  maintain.
- **Transient** (this item, not yet built) — **no** carried-over history at all, not even
  compressed. Each invocation starts clean. This is the right model for a task-executor
  agent like Dispatcher or `routine`: it doesn't need to remember last week's delegation,
  or even necessarily its own previous turn — it needs the current work order and nothing
  else muddying its reasoning.

Projected sessions was seriously considered for this and rejected: its compiler step
(`briefing-host`) is vault-dependent, and a vault-less agent would get a synthetic
"briefing compiler failed" note on every turn plus the same raw-turn tail underneath it —
not a fix, just a different kind of noise. More fundamentally, it's solving the wrong
problem: Dispatcher doesn't need *better* continuity, it needs *none*.

## Where this lives in code

`session_mode` today (`src/types.ts`): `'shared' | 'per-thread' | 'agent-shared'` — a
column on `messaging_group_agents` (channel wiring), consulted by `resolveSession`
(`src/session-manager.ts`). It has no meaning for a2a-only agents like Dispatcher/
`routine`, which have no messaging-group wiring at all.

The actual behavior a2a targets get today is hardcoded, not configured:
`src/modules/agent-to-agent/agent-route.ts:231` —
`resolveSession(targetAgentGroupId, null, null, 'agent-shared')` — the fallback used
whenever a reply can't be routed back to a specific originating session (layers 1/2 of
`resolveTargetSession`'s doc comment). Every a2a-only agent in the system currently gets
`'agent-shared'` unconditionally, with no way to ask for anything else.

## What's not decided yet

- **Where the setting lives for an a2a-only agent.** There's no `messaging_group_agents`
  row to hold a 4th `session_mode` value for something like Dispatcher. Likely a new
  column on `container_configs` (parallel to `cli_scope`, `transport`) rather than trying
  to force it through the channel-wiring table — but not decided.
- **What "transient" actually tears down, and when.** Candidates, not chosen between:
  - Never resume the provider transcript (same mechanism projected-sessions already uses
    to skip resume) but keep the DB session row/id around indefinitely, just always
    starting the *model's* context fresh — cheapest, reuses existing plumbing.
  - Actually delete the session row (and its inbound/outbound DBs) once a work order's
    reply has been sent — a harder "does this session even still exist" cleanup problem,
    but a more literal reading of "transient." Reply-routing itself doesn't need the
    session to survive past sending the reply (source_session_id resolution happens
    within the same turn it's created), so this is *mechanically* safe, just needs a
    concrete trigger for "this work order is done, tear it down."
  - Something in between: keep the row but expire/prune it after an idle window, similar
    in spirit to `src/host-sweep.ts`'s existing "absolute ceiling" container-kill logic
    (which already fired on Dispatcher's session tonight, unrelated to this — that's a
    container-lifetime cap, not a history reset).
- **Interaction with in-flight multi-turn work.** A single work order can involve several
  a2a round-trips (Dispatcher ↔ specialist, possibly ↔ Lumen) before it's "done" — transient
  must not tear down mid-conversation, only between genuinely separate work orders. Needs
  a clear definition of "work order boundary" that doesn't already exist as a first-class
  concept anywhere in the routing layer.
- **Naming.** `transient` is a placeholder, not final.

## Why this wasn't built tonight

Real design work (a new DB column, new resolution logic in a security/routing-sensitive
path, a lifecycle-boundary decision with no existing precedent to copy) stacked on top of
an already long night of live infrastructure fixes (host-shim CLI-output-shape bug,
`Task`-tool subagent dispatch gap, missing `env`/`blockedHosts` on `ncl groups create`-made
groups) is exactly the kind of thing that should be scoped calmly, not improvised at 1am.

## Immediate, unrelated workaround used tonight

Manually cleared Dispatcher's and `routine`'s current session rows so testing could
continue on a clean slate without waiting for this to be built. Not a fix — the same
accumulation will recur immediately without a real `transient` mode.
