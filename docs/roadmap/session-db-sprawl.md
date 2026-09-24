# Work out what the heck is going on with 300+ individual-session databases

Raised 2026-09-23 (David), put at the top of the roadmap. Status: **not started — this is a "understand it first" item, not a decided fix.**

## What was observed (2026-09-23)

A backup of everything under `data/` copied **307 SQLite files** (32 MB total): `v2.db`, plus an `inbound.db` and `outbound.db` for each of **146 sessions** (7 weeks: 2026-08-01 → 09-23), plus 16 `.sync-local/*.db` copies left by session-sync canaries. Roughly 70 sessions each belong to Lumen and to `routine`.

- 276 of the 306 session files are ≤64 KB; the smallest are 36 KB (~9 empty-ish 4 KB pages). A typical tiny pair is one scheduled-task run: the wake message, 1–3 `delivered` rows, 1–2 `destinations`, one `session_routing` row in; a reply + task log + two state rows out. 13 outbound files have every table empty (session created, agent never produced output).
- **106 of 146 sessions are `closed`, but their DB files are still on disk.** The only file removal found in `src/` is the outbox cleanup (`session-manager.ts:673`); not checked exhaustively, so "no retention policy exists" is unverified.
- **16 sessions are `closed` yet `container_status = running`** — looks like stale state; uninvestigated.
- Disk cost is trivial (32 MB). The concern is comprehension and hygiene, not space.

## Open questions (why this is an "understand" item)

- Is one-session-per-scheduled-task-run (isolated per-series sessions, `ncl tasks`) actually what we want, or an accident of how the task feature landed? What is the intended session lifecycle end to end?
- Is there any pruning of closed sessions? Should there be (archive, delete, compact into one history store)? What must survive (chat history for long conversational sessions vs. throwaway task runs)?
- Why do closed sessions show `container_status = running`? Bug in status bookkeeping, or a real lingering container?
- What creates the empty ones — spawn-then-nothing? Wasted container starts?
- Interaction with session-sync ([session-sync-transport.md](../session-sync-transport.md)): per-session chain state and `.sync-local` copies multiply with session count; a per-session design means every stale session is another place state can diverge (§0.5–0.6 there).

## Suggested first steps

1. Read the session lifecycle in `session-manager.ts` / `host-sweep.ts` / `ncl tasks` code and write down the intended lifecycle (create → active → closed → ?).
2. Classify the 146 sessions (task-run vs conversational, empty vs non-empty, closed vs active) — a query, not a change.
3. Investigate the closed/`running` mismatch.
4. Only then decide on retention/pruning; nothing should be deleted before the lifecycle is understood. The 2026-09-23 backup is at `~/Backups/lumen-nanoclaw-db-20260923`.
