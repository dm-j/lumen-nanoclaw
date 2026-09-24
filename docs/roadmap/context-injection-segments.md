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

---

# Specification (proposed 2026-09-24, nothing built)

Turns the decisions above into a buildable spec for the **assembler**: the piece that prepares each segment and renders them, in
order, into the block injected ahead of every turn.

## Scope

- **In scope:** the per-turn dynamic context block that `wake_script` produces today (`<wake-context>` in `poll-loop.ts`).
- **Out of scope:** the system prompt (`claude-md-compose.ts`), the compiled `<briefing>`/`<recent-turns>` (they keep their own path),
  and per-task `--script` gates on scheduled tasks (a different mechanism with a different job).

## Adoption in two stages

- **Stage 0, instance-only, no trunk change (recommended first).** The assembler is a host-shim, `context-assemble`, in each group's
  host-shims directory (a thin wrapper over one shared implementation in the instance repo). The group's `wake_script` shrinks to one
  line, `host-shim context-assemble`; the assembler prints the JSON the wake-script contract already expects
  (`{"wakeAgent": true, "data": "<rendered block>"}`), so `poll-loop.ts`, the container image and `container.json` are untouched. It
  inherits the existing whitelist, timeouts and `<wake-context>` placement.
- **Stage 1, trunk-native, only if Stage 0 shows the need:** a host module called at prompt-build time with the segment list in
  `container_configs`, able to place segments relative to `<briefing>`/`<recent-turns>` (today the wake block always comes first).

## Layout (Stage 0)

Segments are executables, discovered and run by the assembler itself (not registered as shims), under the group's shims directory:

```
host-shims/<group>/context-assemble-host          thin wrapper; the shared implementation lives beside it
host-shims/<group>/context-segments/
    10-notes            (or a symlink to a shared implementation)
    20-todo
    segments.json       optional per-segment overrides (cap, timeout, title, enabled)
```

Order is the numeric prefix. Adding a segment is dropping one executable in the directory; removing one is deleting or disabling
it; no restart, because the assembler re-reads the directory on every turn. Lumen's list is hers; Routine's is its own short list.
Shared code (`notes`, `todo`) lives once and is symlinked or wrapped per group.

## Segment contract

- **Input (environment):** `SEGMENT_GROUP_ID`, `SEGMENT_WHO` (`lumen`, `routine`), `SEGMENT_TZ` (the group's timezone),
  `SEGMENT_NOW` (ISO instant), `SEGMENT_MAX_CHARS`. This replaces hand-set constants in wrappers.
- **Output:** plain text on stdout. **Empty (after trimming) means "nothing to show" and the segment is omitted silently.**
- **Status:** exit 0 is success; a non-zero exit or a timeout is a failure, rendered visibly (below).
- **Independent and read-only.** No segment reads another's output, and injection segments must not write. This matters because
  segments run in parallel: `notes read` currently *heals* a missing `## Notes` block (a write), and two writers on the same day
  note would race (its compare-and-write would make one of them fail). Injection segments read; healing stays on the write path.
- **Content is data.** A segment that carries text authored by a person or third party (notes, todos, calendar descriptions) is
  untrusted input to the model; an optional per-segment flag could wrap it in a clear delimiter. Recorded, not decided.

## Assembly rules

1. Discover segments (sorted by numeric prefix), apply `segments.json` overrides, skip disabled.
2. Run **all concurrently**, each with its own timeout (default 5 s).
3. Trim each output. Empty means omit. Over its cap (default 4000 characters) means cut at a line boundary and append a marker such as
   `[...truncated: use notes_read for the full list]` (the segment can supply the hint).
4. **Failure is visible:** a failed or timed-out segment renders as `[<title>: unavailable (<reason>)]`, never silently dropped, so the
   model knows something is missing. It never blocks the turn or the other segments.
5. **Total budget** (default 8000 characters): if the sum exceeds it, drop whole segments from the end of the list (or lowest explicit
   priority) and add one line, `[omitted for size: <names>]`. Never truncate mid-segment to fit.
6. **Render** an always-present preamble (today's date and weekday, built in, not a segment) followed by each surviving segment in
   order inside its own XML tag named for the segment, consistent with `<briefing>` and `<recent-turns>` elsewhere in the prompt:

   ```
   Today is Thursday 2026-09-24.
   <notes>
   [3o1fng] 22:17 lumen: ...
   When a note is no longer useful ... actively delete it with notes_delete.
   </notes>
   <todo>
   ...
   </todo>
   ```

   Any instruction that belongs to a segment (for example the "delete what is done" advice) is part of that segment's output.
7. Print the wake-script envelope for Stage 0. If every segment is empty the preamble alone is still sent (date grounding).

## Time budget

The container-side wake script has a 30 s cap and 1 MB output cap. The assembler should finish well inside that: a 10 s overall
deadline with 5 s per segment. A cold segment costs about 0.75 s (measured 2026-09-23), so N parallel segments cost about the slowest,
plus one host-shim roundtrip (not measured). Everything is per turn; caching a slow segment (TTL) is not needed for v1 and
would only matter for something LLM-compiled.

## Observability and preview

- Each assembly appends one JSON line per segment (group, segment, milliseconds, characters, status) to a log under `logs/`.
- **Preview** is just running the assembler by hand on the host for a group; it prints the exact block plus a per-segment table
  (time, size, status) and wakes no agent. It replaces today's only check, spawning an agent turn and asking her to quote the context back.

## Failure and safety

- One bad segment cannot stop the turn. If the assembler itself fails, the wake script emits nothing and the turn proceeds without
  the block; the failure is logged.
- Segments are host-side files in the group's own whitelisted directory: invisible to the agent, and an agent cannot add or edit one.
- Everything injected goes to the model provider on every turn: keep caps tight, and treat any new segment as a data-exposure decision.

## Migration

1. Build the assembler and its self-check (fake segments: ordering, cap and truncation marker, failure marker, timeout, budget drop,
   empty omission), plus preview.
2. Port `notes` as `10-notes` for Lumen and for Routine (date line moves into the preamble; the delete advice stays with the segment;
   the reader stops healing). Replace both `wake_script` strings with the one-liner. The previous scripts are recorded in
   [routine-daily-notes.md](routine-daily-notes.md) for rollback.
3. Add `20-todo` for Lumen when its source is decided ([per-day-todos.md](per-day-todos.md),
   [task-graph-dependencies.md](task-graph-dependencies.md): the "available leaves" list is a natural first todo segment).

## Acceptance checks

- Three segments assemble in about the time of the slowest, not the sum.
- A hung segment is cut at its timeout and marked; the others render.
- Over budget drops whole trailing segments and says which.
- Preview output matches what a live turn receives.
- Adding a segment is one file in the directory; nothing else changes.
- Lumen's and Routine's blocks come out as before for the notes-only case (apart from the tag wrapper and date preamble).

## Settle at build time

Where the segments directory lives (host-shims, or a new sibling like `mcp-shims`); XML tags versus headings; explicit priority
versus order-only; whether `segments.json` is needed at all beyond defaults; whether Stage 1 (placement relative to the briefing)
is worth it.
