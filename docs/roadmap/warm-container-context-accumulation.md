# Warm-container context accumulation breaks the projected-session guarantee

**Discovered 2026-08-15**, while diagnosing a "Prompt is too long" failure in `lumen-dmj`. Projected sessions (`src/modules/projected-sessions/`) exist specifically so a session never accumulates an ever-growing context — `continuation` is deliberately cleared every turn (`poll-loop.ts`), so each turn is supposed to be a fresh compile (small `briefing.md` + bounded `recent-turns.md`) rather than a resumed transcript. That guarantee does not actually hold for the lifetime of one running container.

## What actually happens

When a message arrives while a container is already running (warm), `poll-loop.ts` pushes it as a follow-up into the *same still-open* model query (`"[poll-loop] Pushing 1 follow-up message(s) into active query"`, visible in container stderr) instead of starting a new one. That live, in-memory conversation keeps every prior turn's content for as long as the container stays up — up to the 30-minute absolute-ceiling before it's killed (`src/container-runner.ts`, `ceilingMs`). Rewriting `briefing.md`/`recent-turns.md` on disk between turns has no effect on a query that's already open; the container only sees the fresh, small files on its *next* fresh spawn.

Confirmed directly: a `lumen-dmj` container that had been running ~2 hours (many exchanges, several dozen turns) kept failing with "Prompt is too long" even after the actual root cause (a separate compiler-side bug, since fixed — see [Reconcile host-shim trunk templates](reconcile-host-shim-templates.md)'s addendum) was resolved and confirmed small on disk. Only killing the container (`ncl groups restart`) — forcing a genuinely fresh spawn, fresh query — actually fixed it.

## Why this matters

This isn't just today's specific bug — it means projected sessions are currently only as lightweight as the *shortest* of (a) the per-turn compiled briefing/tail, or (b) how long the container has stayed warm. A long, chatty conversation that never triggers a container respawn will keep growing exactly like a resumed transcript would, silently defeating the entire point of the projected-session redesign, until the 30-minute ceiling forces a kill. Any bug that transiently blows up one turn's content (like today's) then persists for the rest of that container's uptime even after the bug is fixed upstream.

## Fix shipped (2026-08-15)

Landed in `container/agent-runner/src/poll-loop.ts`, gated on the already-imported `isProjectedSession()` (resumed sessions are untouched — reopening those really is expensive, a `.jsonl` transcript reload).

Chose exit-and-respawn over in-process query surgery: rather than aborting the live `AgentQuery` and opening a fresh one mid-container (unverified as cheap, and would require manually resetting every other per-query variable — `archivePrompts`, `unwrappedNudged`, `taskBlockNudged`, `corruptionStreak` — to avoid stale-state bugs), the reset reuses the exact exit path already proven for SQLite corruption recovery: log a named marker, stop the poll interval, `process.exit(75)`, let host-sweep respawn a clean container. A process exit resets all per-query state for free.

Trigger: `followUpsPushed >= PROJECTED_FOLLOWUP_RESET_COUNT` (30, i.e. `2 * RESPONDER_TAIL_TURNS`) or `Date.now() - queryOpenedAt > PROJECTED_QUERY_TTL_MS` (5 min, matching `DEFAULT_CACHE_TTL_MS`). Both constants are duplicated in `poll-loop.ts` rather than imported — `container/agent-runner` is a separate Bun package tree with no access to host-side `src/`. The follow-up batch that hits the threshold is left pending, same as any other batch when the container dies mid-conversation — the host's processing-claim sweep releases it, and the fresh container picks it up on its next poll along with a freshly compiled, small `briefing.md`/`recent-turns.md`.

Verified: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` clean, `bun test` 170/171 pass (1 pre-existing skip), no regressions.

## Not yet investigated

- Whether this should surface as an operator-visible signal (e.g. a log line distinguishable from a normal ceiling-kill) — currently just `PROJECTED_QUERY_RESET` in stderr, no dashboard/alert wiring.
- Whether 30 follow-ups / 5 min are the right defaults in practice, or need tuning once this has run for a while — no telemetry on how often the reset actually fires yet.
- If container respawn latency (a few seconds) ever becomes a measured problem for a chatty conversation, revisit in-process query reset instead of exit-and-respawn.
