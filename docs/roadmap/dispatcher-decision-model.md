# Dispatcher: replace the agent with a decision model

**ABANDONED 2026-10-26.** Not built, and not going to be.

**Why:** a stateless one-shot decision model is incompatible with task decomposition and orchestration, which is the
substance of what Dispatcher does (decompose → several agents → combine, route replies back, keep workflow state).
A single call that returns one destination cannot do any of that. The "keep the agent as fallback" front-door variant
below was considered, but it would add a second routing path and an escalation rule to maintain for the sake of the
simple case only; not worth it. Dispatcher stays a full agent.

If this is ever revisited, the only angle left is a narrow one: cheaply pre-filtering obviously single-destination
messages. Start by measuring how many real Dispatcher runs are single-destination before reopening it.

The original proposal is kept below for the record.


## Idea

Dispatcher is currently a full agent (container, warm context, workflow-state files, multi-turn). Most of what it does
for a given message is a *choice*: which agent should get this. Replace that choice with a single stateless model call:

- input: the message content + the "Available agents" list (destination name → `agent_groups.description`, the same
  data the CLAUDE.md fragment is generated from — see [dispatcher-agent.md](../dispatcher-agent.md))
- output: one destination (constrained to the list), optionally a rewritten task string
- no container, no accumulated context, cheap/fast model, one query per message

This is the same shape as the projected-sessions briefing compiler (host-side call through PrefixRouter), so the
plumbing and the cost model already exist.

## Caveat that decides the design

The agent does more than pick a destination. Before replacing it, enumerate what it also does:

1. Multi-step work (decompose → several agents → combine). A one-shot classifier cannot do this.
2. Async reply routing (results coming back from the target to the original asker).
3. Workflow-state files across turns.
4. Saying "none of the agents fit" / asking a clarifying question.

Proposed split: the decision model handles the common single-destination case; anything it marks `multi`, `none` or
low-confidence escalates to the existing Dispatcher agent. That keeps the agent as fallback instead of deleting it.

## "Another session type"

Open: a single query does not strictly need a session. Options, cheapest first:
(a) a host-side function called from the router / `assign_task` path, logged to a table — no session at all;
(b) a lightweight session type (no container) so every decision lands in the normal session DBs and is auditable the
same way other traffic is. Choose (b) only if the audit trail in the session DBs is wanted; otherwise (a).

## Open questions

- Where the call sits: router (before any agent wakes) or inside the `assign_task` path.
- Model: use a PrefixRouter role alias (check `GET :8787/aliases`) rather than a literal model string.
- Output enforcement: constrained choice / JSON schema with the destination validated against the real list; reject
  anything not in the table (matches Dispatcher's closed-world rule).
- Evaluation: replay logged Dispatcher decisions as a test set before switching anything live; track agreement rate.
- Descriptions become load-bearing: a vague `description` now *is* the routing quality. Audit them first.
