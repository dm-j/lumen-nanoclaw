# Roadmap

Open items, roughly in priority order. Not a commitment or schedule — just what's known to be outstanding. Each item is its own file under `docs/roadmap/` — this index stays a thin list of links on purpose, so adding, reordering, or updating one item never touches the others.

1. [Session-sync WebSocket transport](session-sync-transport.md) — replaces bind-mounted session DBs (recurring macOS SQLite corruption / `DB_RETRY_EXHAUSTED`); four canary rounds on 2026-08-16 found and fixed 9 real bugs total; the fourth round also found the connection reliably drops every ~40s specifically over the container→host Docker Desktop networking path (confirmed environmental via a direct host-to-host probe, not fixable in this codebase) — all three groups rolled back to `'file'` transport the same night (§8.11); next attempt needs either a fix/mitigation for the Docker-side drop or outbound retry-across-reconnect (mirroring the inbound replay that already exists), plus redoing the staged canary process for real
2. [Container runner as a pluggable interface](roadmap/container-runner-interface.md) — decouple container spawn/lifecycle from `container-runner.ts`'s local-Docker assumption, so a runner can register itself and run anywhere; discussed 2026-08-15, not started, depends on session-sync landing first
3. [.ics handling](roadmap/ics-handling.md) — no calendar ingestion/generation yet
4. [Email handling](roadmap/email-handling.md) — no email channel/adapter yet
5. [Task handling](roadmap/task-handling.md) — scope TBD against the existing `ncl tasks` system
6. [Re-implement or drop `wikilink-query`](roadmap/wikilink-query.md) — v1 vault shim never ported to v2, currently dropped
7. [Post-turn topics agent, driven by real MCP-shim tools](roadmap/topics-agent-mcp-shims.md) — discussed 2026-08-15, not started
