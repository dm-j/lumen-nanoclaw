# Local Patch Notes

A history of what's been locally changed on this NanoClaw install, on top of upstream, grouped by calendar day. For an administrator who manages this install day to day but wasn't present for the work — not a commit-by-commit changelog. Each day is its own file under `docs/local-patch-notes/` — this index stays a thin, chronological list of links. Days with only trivial or reverted-out changes are omitted.

1. [2026-08-01](local-patch-notes/2026-08-01.md) — Introduced the vault memory pipeline (live transcript export, daily/weekly digests) and the projected-sessions briefing compiler, plus per-agent-group host-shim segregation and container env overrides.
2. [2026-08-02](local-patch-notes/2026-08-02.md) — Added the Telegram channel and `remember`/`recall` memory tools.
3. [2026-08-03](local-patch-notes/2026-08-03.md) — Timeout and cache-TTL fixes for the briefing compiler.
4. [2026-08-04](local-patch-notes/2026-08-04.md) — Shipped mcp-shims v1, letting host scripts become MCP tools without a full MCP server.
5. [2026-08-05](local-patch-notes/2026-08-05.md) — Stability pass across host-shim/mcp-shim/projected-sessions: corruption retries, self-healing stuck messages, and better briefing formatting.
6. [2026-08-06](local-patch-notes/2026-08-06.md) — Subagent env inheritance, opt-in gating for vault transcript export, and further briefing formatting polish.
7. [2026-08-07](local-patch-notes/2026-08-07.md) — Split install-specific files into a separate private instance repo with automatic sync hooks.
8. [2026-08-13](local-patch-notes/2026-08-13.md) — Started the session-sync project (a WebSocket replacement for bind-mounted session DBs), hardened the pre-commit hook against bad filenames/characters, and added a standalone `pm-shim-server` to Lumen's agent group.
9. [2026-08-14](local-patch-notes/2026-08-14.md) — Session-sync Phase 1: host WebSocket server and container mirror client (not yet turned on for any real group).
10. [2026-08-15](local-patch-notes/2026-08-15.md) — Session-sync Phase 2: full push/reconnect/shutdown machinery and a written switchover plan (still not live); also added a working-memory `focus-updater` to Lumen's briefing.
11. [2026-08-16](local-patch-notes/2026-08-16.md) — Live-tested session-sync on real agent groups across two rounds, fixed several real bugs, then rolled it back after hitting an unfixable Docker networking issue; added crash-notification DMs to admins.
12. [2026-08-20](local-patch-notes/2026-08-20.md) — Cleanup following the session-sync work: dead code removal and forward-compatibility fixes; deactivated the new working-memory `focus-updater` after it was found rewriting unrelated content, and added the `lumen-voice` prose-to-script annotation tool.
13. [2026-09-02](local-patch-notes/2026-09-02.md) — Scheduled tasks skip unnecessary briefing compilation on cold gated-task-only wakes; retired the departure agent group's host-shims and added a family of Vector-robot MCP tools.
14. [2026-09-15](local-patch-notes/2026-09-15.md) — Laid the groundwork for multi-agent delegation (agent group descriptions plus an auto-generated routing table) and stood up the first concrete coordinator, the Dispatcher agent group.
15. [2026-09-16](local-patch-notes/2026-09-16.md) — Multi-agent delegation goes live: the `routine` agent, a Computation specialist agent, per-task a2a sessions (`assign_task`), ack-loop breakers, `--stateless` scheduled tasks, and calendar tool fixes/handoff to Routine.
16. [2026-09-18](local-patch-notes/2026-09-18.md) — Added a per-agent-group `wake_script` and wired/verified Routine's daily-note awareness; fixed a vault-transcript recipient routing bug; scoped a plan for Routine to read/edit the calendar via the vault's local mirror.
17. [2026-09-19](local-patch-notes/2026-09-19.md) — Roadmap-staleness sweep (closed 3 stale items, corrected 4 more) and a strengthened roadmap-maintenance rule; fixed a `tsx` deprecation warning and added the Minimal Friction principle to CLAUDE.md.
18. [2026-09-21](local-patch-notes/2026-09-21.md) — Added mcp-shims overview and per-group inventory docs; fixed a worktree hook bug.
19. [2026-09-22](local-patch-notes/2026-09-22.md) — Fixed a runaway a2a guard-wake loop that crash-looped the host; worktrees auto-provision on checkout; Routine's calendar became vault-backed with add/edit/conflict-scan shims.
20. [2026-09-23](local-patch-notes/2026-09-23.md) — Session-sync handler crash fixed (sync-drop traced to chain divergence); fresh-install backup/restore scripts; notes shims and wake-script notes block for Routine and Lumen.
21. [2026-09-24](local-patch-notes/2026-09-24.md) — Notes double-signing fixed and a `journal_entry` tool added for Lumen.
22. [2026-09-25](local-patch-notes/2026-09-25.md) — Disabled Lumen's Vector shims; `journal_entry` description made a relevance gate.
23. [2026-09-26](local-patch-notes/2026-09-26.md) — Central shim pool with per-group allowlist registry, shared day-token resolver, `get_calendar` with `lumen_file_id`, and recall/briefing shim fixes.
24. [2026-09-28](local-patch-notes/2026-09-28.md) — Agent-runner dumps each turn's prompt to `/workspace/last-prompt.md`.
25. [2026-09-29](local-patch-notes/2026-09-29.md) — Raw briefer output logged per day under `logs/briefing-raw/`.
26. [2026-09-30](local-patch-notes/2026-09-30.md) — Added the `research` task agent group and a `transcript-prune` host shim.
27. [2026-10-01](local-patch-notes/2026-10-01.md) — Unresolvable recall citations become `[UNSUPPORTED]`.
28. [2026-10-03](local-patch-notes/2026-10-03.md) — Added `agent_groups.decision_description`; retired `researchagent` for `research`; soft tool limits for Routine and Computation.
29. [2026-10-05](local-patch-notes/2026-10-05.md) — SQLite errors in the agent-runner now name DB file, operation and SQL.
30. [2026-10-07](local-patch-notes/2026-10-07.md) — Idle container reaps demoted to INFO; last-context Stop-hook dump added.
31. [2026-10-08](local-patch-notes/2026-10-08.md) — ISO-8601 UTC host log timestamps; projected-session prompt-size cuts; unused built-in tool definitions denied; `x-agent-group` header.
32. [2026-10-12](local-patch-notes/2026-10-12.md) — Host-cron keeps 4000 chars of failed-job stderr.
33. [2026-10-13](local-patch-notes/2026-10-13.md) — Opt-in `set_followup` timer, `scripts/netwatch.sh`, and `obsidian_*` tools for Lumen.
34. [2026-10-20](local-patch-notes/2026-10-20.md) — Nightly backup script and roadmap items for offsite backup, delivery retry and network reliability.
35. [2026-10-26](local-patch-notes/2026-10-26.md) — Recorded the abandoned Dispatcher decision-model idea.
36. [2026-10-27](local-patch-notes/2026-10-27.md) — Weekly log rotation script, quieter pre-commit, and projected-session tail trial.
37. [2026-11-03](local-patch-notes/2026-11-03.md) — Message `subject`, ordered/backed-off Telegram retries and diagnostics, approval expiry, new Vision and Vault agent groups, multi-file `send_file`/`assign_task`.
