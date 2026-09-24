# Modular context injection: ordered segments (design agreed, nothing built)

Discussed 2026-09-23. Notes are the second thing injected into Lumen's per-turn context (the first is the compiled
briefing/tail), and David expects more (his to-do list). Today's per-turn injection is one shell script in a DB column
(`container_configs.wake_script`), edited through a quoting-hostile CLI argument; adding the notes cap, the date line and the
delete advice each meant rewriting the whole string. This item replaces that with a small, reorderable structure.

## What injects context today

| Layer | Runs | Source | Freshness |
|---|---|---|---|
| Standing instructions | host, at spawn | ordered fragments composed into `CLAUDE.md` (`src/claude-md-compose.ts`) | static |
| `<briefing>`, `<recent-turns>` | host, before the wake | LLM-compiled files (`projected-sessions/`), read by `container/agent-runner/src/projected-sessions.ts` and placed by `formatter.ts` | cached, slow |
| `<wake-context>` | container, every batch of messages | the group's `wake_script` (one shell string), prepended in `poll-loop.ts` | fresh, cheap |

Per-turn prompt today: `<wake-context>` + `<briefing>` + `<recent-turns>` + `<context .../>` + messages.

## Decisions (David + Claude)

1. **Ordered list of independent segments, concatenated. Not a chained pipeline.** No segment consumes another's output. That gives
   failure isolation, parallelism, per-segment caps and free reordering. If a later stage needs to see the whole (e.g. an LLM that
   trims the total), it is an optional *final* step, added only when needed.
2. **One shared runner** does the preparing and concatenating (run segments, apply timeout and character cap, render a uniform
   envelope, mark failures visibly, e.g. "todo: unavailable" rather than silently omitting). Every agent uses the same runner.
3. **Segment code is shared and parameterized per group.** `notes` and `todo` are one implementation each; the runner passes the group's
   timezone and name (replacing the hand-set `NOTES_GROUP_ID`/`NOTES_WHO` in each wrapper, for segments).
4. **The list is per group.** Lumen's list is hers (projected context: briefing/tail slots, notes, todo, ...). **Routine does not share it:**
   it is stateless, gets no projected context, and its list holds only its routine-related segments (notes today).
5. **Runs host-side in ONE call.** Each segment costs ~0.75 s (cold `tsx` start plus a vault read, measured 2026-09-23). Chained through
   the container that is N x (0.75 s + a transport roundtrip) on every turn; one host-side runner executing segments in parallel
   costs about the slowest one plus one roundtrip. Same trust model as host-shims/mcp-shims: files in a whitelisted per-group
   directory, invisible to the agent, and an agent cannot add one.
6. **Segments live as files in the instance repo** (versioned, diffable), not in a DB column. Numbered filenames give the order
   for free (`10-notes`, `20-todo`), `run-parts` style, unless a per-group manifest turns out to be needed.
7. **A `preview` command** prints a group's assembled injection without waking the agent. Today the only way to verify an injection is
   to spawn an agent turn and ask her to quote it back; preview makes that deterministic and testable.
8. **Briefing and recent-turns stay as they are** (their compiler is not rewritten). They may get named slots in the same order list
   later so their position can be changed the same way; first version leaves them alone.
9. **The to-do segment is called `todo`**, not "tasks": "tasks" already means the `ncl tasks` scheduler in this codebase.

## Open questions

- **To-do source.** Probably the existing `mcp-shims/lumen-dmj/task_management/` (`tasks_list`), i.e. vault to-do capture; confirm with
  David that this is "his to-do list", and what a rendered list should look like (open items only, ordering, cap).
- **Order and prompt-cache.** Stable content first, volatile last, is the usual rule; today the volatile `<wake-context>` sits before the
  briefing. Worth a measured one-line experiment once order is configurable (see `docs/prefixrouter-cache-status.md`).
- **What "routine-related details" means for Routine** beyond the notes it gets today (candidates: today's events, its due
  tasks); decide when we get there.
- **Fate of `wake_script`.** Likely superseded by the runner; keep the column as a legacy escape hatch or drop it once nothing uses it.
- **Privacy/size.** Everything injected goes to the model provider on every turn; each segment gets a cap and the total gets a budget.
- **Non-projected agents.** Lumen never resumes a transcript, so per-turn injections do not pile up in her history; an agent that does
  resume would accumulate them (only-if-changed would be needed). Not a concern for Lumen or (stateless) Routine.

## Suggested order when this is built

1. The shared runner as one host-shim, with per-segment cap/timeout/failure marker and the preview command.
2. Move `notes` (with its date line and delete advice) in as the first numbered segment, for both Lumen and Routine; retire the two
   `wake_script` strings.
3. Add the `todo` segment for Lumen.
4. Optionally give briefing and recent-turns named slots in the order list.
