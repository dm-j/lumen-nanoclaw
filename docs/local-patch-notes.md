# Local Patch Notes

A history of what's been locally changed on this NanoClaw install, on top of upstream, grouped by calendar day. For an administrator who manages this install day to day but wasn't present for the work — not a commit-by-commit changelog. Each day is its own file under `docs/local-patch-notes/` — this index stays a thin, chronological list of links. Days with only trivial or reverted-out changes are omitted.

1. [2026-08-01](local-patch-notes/2026-08-01.md) — Introduced the vault memory pipeline (live transcript export, daily/weekly digests) and the projected-sessions briefing compiler, plus per-agent-group host-shim segregation and container env overrides.
2. [2026-08-02](local-patch-notes/2026-08-02.md) — Added the Telegram channel and `remember`/`recall` memory tools.
3. [2026-08-03](local-patch-notes/2026-08-03.md) — Timeout and cache-TTL fixes for the briefing compiler.
4. [2026-08-04](local-patch-notes/2026-08-04.md) — Shipped mcp-shims v1, letting host scripts become MCP tools without a full MCP server.
5. [2026-08-05](local-patch-notes/2026-08-05.md) — Stability pass across host-shim/mcp-shim/projected-sessions: corruption retries, self-healing stuck messages, and better briefing formatting.
6. [2026-08-06](local-patch-notes/2026-08-06.md) — Subagent env inheritance, opt-in gating for vault transcript export, and further briefing formatting polish.
7. [2026-08-07](local-patch-notes/2026-08-07.md) — Split install-specific files into a separate private instance repo with automatic sync hooks.
8. [2026-08-13](local-patch-notes/2026-08-13.md) — Started the session-sync project (a WebSocket replacement for bind-mounted session DBs) and hardened the pre-commit hook against bad filenames/characters.
9. [2026-08-14](local-patch-notes/2026-08-14.md) — Session-sync Phase 1: host WebSocket server and container mirror client (not yet turned on for any real group).
10. [2026-08-15](local-patch-notes/2026-08-15.md) — Session-sync Phase 2: full push/reconnect/shutdown machinery and a written switchover plan (still not live).
11. [2026-08-16](local-patch-notes/2026-08-16.md) — Live-tested session-sync on real agent groups across two rounds, fixed several real bugs, then rolled it back after hitting an unfixable Docker networking issue; added crash-notification DMs to admins.
12. [2026-08-20](local-patch-notes/2026-08-20.md) — Cleanup following the session-sync work: dead code removal and forward-compatibility fixes.
13. [2026-09-02](local-patch-notes/2026-09-02.md) — Scheduled tasks skip unnecessary briefing compilation on cold gated-task-only wakes.
14. [2026-09-15](local-patch-notes/2026-09-15.md) — Laid the groundwork for multi-agent delegation: agent group descriptions plus an auto-generated routing table for coordinator agents.
15. [2026-09-16](local-patch-notes/2026-09-16.md) — Multi-agent delegation goes live: the `routine` agent, per-task a2a sessions (`assign_task`), ack-loop breakers, and `--stateless` scheduled tasks.
