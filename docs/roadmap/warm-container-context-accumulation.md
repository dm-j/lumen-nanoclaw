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

Trigger: `followUpsPushed >= PROJECTED_FOLLOWUP_RESET_COUNT` (12 since 2026-10-08, equal to `RESPONDER_TAIL_TURNS`; was 30 = `2 * RESPONDER_TAIL_TURNS` — see the addendum) or the provider prompt cache is no longer live per PrefixRouter's `/cache-status` (originally a fixed 5-min query-age TTL, `PROJECTED_QUERY_TTL_MS`, replaced 2026-10-08 — see the addendum). Both constants are duplicated in `poll-loop.ts` rather than imported — `container/agent-runner` is a separate Bun package tree with no access to host-side `src/`. The follow-up batch that hits the threshold is left pending, same as any other batch when the container dies mid-conversation — the host's processing-claim sweep releases it, and the fresh container picks it up on its next poll along with a freshly compiled, small `briefing.md`/`recent-turns.md`.

Verified: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` clean, `bun test` 170/171 pass (1 pre-existing skip), no regressions.

## Not yet investigated

- Whether this should surface as an operator-visible signal (e.g. a log line distinguishable from a normal ceiling-kill) — currently just `PROJECTED_QUERY_RESET` in stderr, no dashboard/alert wiring.
- Whether 30 follow-ups / 5 min are the right defaults in practice, or need tuning once this has run for a while — no telemetry on how often the reset actually fires yet.
- If container respawn latency (a few seconds) ever becomes a measured problem for a chatty conversation, revisit in-process query reset instead of exit-and-respawn.

## Addendum 2026-10-08 — what the data says, decisions, open items

**Data** (525 `PROJECTED_QUERY_RESET` lines in `logs/nanoclaw.error.log`): 272 fired with 0 follow-ups pushed, 126 with 1, 88 with 2–5, 10 with 7–14, and only 7 hit the 30 limit. So ~98% of resets come from the TTL, not the count. The TTL is measured from `queryOpenedAt` (query *age*), not idle time, so any follow-up arriving >5 min after spawn forces a respawn even in an active chat. Each reset also logs as a WARN "Container exited non-zero" (code 75) — expected, but noisy.

**Decided (David, 2026-10-08):**
- `RESPONDER_TAIL_TURNS` 15 → 12, and `PROJECTED_FOLLOWUP_RESET_COUNT` 30 → 12 (= N). Criterion: the on-disk tail restarts at N and grows to 2N, so a warm query should add at most ~N turns on top of its starting tail. Turns are a rough proxy for size but simple; the constant is still hand-duplicated in `poll-loop.ts`.
- The TTL should follow the provider's real prompt-cache expectation, not a fixed 5 min: PrefixRouter's per-endpoint `cacheTtlMs` (currently 5 min for most endpoints, 1 h and 2 h for others) and its `POST /cache-status` (`ttl` / `ollama-ps` / `lmstudio-state` probes). Some providers (local Ollama) hold cache far longer.

**Open / found while looking:**
- **Likely bug, responder tail:** PrefixRouter only records a send when the inference request carries an `x-session-id` header (`server.js:596`). Nothing in this repo sets that header on inference (only the `/cache-status` query does), and PrefixRouter's request logs show no session ids. So `checkCacheStatus` should always answer "expired", making `cacheStale` true and `needsReset` true on every responder call in `literal-tail.ts` — i.e. the tail never grows anchored N→2N and the prefix cache is defeated each turn. Unverified end-to-end; verify, then fix by setting `x-session-id` (same `sessionBriefingKey`) on the container's inference, e.g. `ANTHROPIC_CUSTOM_HEADERS`.
- Once that header exists the container could ask `/cache-status` before each follow-up (live → keep the warm query, expired → respawn) instead of a fixed TTL; fall back to idle-time-since-last-message vs. the endpoint TTL when unreachable.
- **Header wiring written 2026-10-08 (not yet deployed/verified):** `container-runner.ts` sets `ANTHROPIC_CUSTOM_HEADERS=x-session-id: <key>` for projected sessions, with the key from `projectedSessionKeyFor` (`synthesize.ts`), identical to the key `literal-tail` queries `/cache-status` with. Verify after deploy: send Lumen a message, then `POST /cache-status` with that key and Lumen's model — should read `live` (it read `expired` before).
- **Built 2026-10-08:** the fixed query-age TTL is gone. On each follow-up the container asks PrefixRouter's `/cache-status` (session key parsed from `ANTHROPIC_CUSTOM_HEADERS`, model from `container.json`); `projectedResetReason` (`container/agent-runner/src/projected-sessions.ts`) resets on count (12), on `expired`, or — only when status is unknown/unreachable — on idle time since the last query activity > 5 min (`PROJECTED_QUERY_FALLBACK_TTL_MS`). Unit-tested in `projected-sessions.test.ts`.
- Host side built + service restarted 2026-10-08 ~18:12Z. Container side is a shared read-only mount, so it applies from each group's next spawn. Header verification pending a natural Lumen wake.
