# Roadmap

Open items, roughly in priority order. Not a commitment or schedule — just what's known to be outstanding. Each item is its own file under `docs/roadmap/` — this index stays a thin list of links on purpose, so adding, reordering, or updating one item never touches the others.

1. [Session-sync WebSocket transport](session-sync-transport.md) — replaces bind-mounted session DBs (recurring macOS SQLite corruption / `DB_RETRY_EXHAUSTED`); Phase 0-1 done, **Phase 2 (container sync client) starts next** — host server itself isn't even started yet
2. [.ics handling](roadmap/ics-handling.md) — no calendar ingestion/generation yet
3. [Email handling](roadmap/email-handling.md) — no email channel/adapter yet
4. [Task handling](roadmap/task-handling.md) — scope TBD against the existing `ncl tasks` system
5. [Re-implement or drop `wikilink-query`](roadmap/wikilink-query.md) — v1 vault shim never ported to v2, currently dropped
6. [Post-turn topics agent, driven by real MCP-shim tools](roadmap/topics-agent-mcp-shims.md) — discussed 2026-08-15, not started
