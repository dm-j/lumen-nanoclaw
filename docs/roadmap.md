# Roadmap

Open items, roughly in priority order. Not a commitment or schedule — just what's known to be outstanding. Each item is its own file under `docs/roadmap/` — this index stays a thin list of links on purpose, so adding, reordering, or updating one item never touches the others.

1. [Session-DB sprawl: 300+ per-session databases](roadmap/session-db-sprawl.md) — 146 sessions × 2 DBs (+ sync-local copies) since 2026-08-01; 106 sessions `closed` but files retained, 16 `closed` yet `container_status=running`; no verified retention policy. Understand the intended session lifecycle before changing anything (raised 2026-09-23)
2. [Session-sync WebSocket transport](session-sync-transport.md) — mechanism fully built, not live anywhere real (all groups on `'file'` as of 2026-09-23). Three isolated repros (raw TCP, Node+WSS, Bun+WSS, each matching the real runtime) all ran 150s clean — the historical ~40s Docker Desktop drop doesn't reproduce standalone. A real live-traffic canary attempt on Lumen got contaminated by an unrelated host OOM outage (a stale container.json + an a2a guard-loop bug, both now fixed) before it could produce a trustworthy result either way. See the doc's own "0.1 Addendum 2026-09-22/23" for the full picture and recommended next step (redo the staged canary on a low-stakes group now that the contaminating bugs are fixed)
3. [Container runner as a pluggable interface](roadmap/container-runner-interface.md) — decouple container spawn/lifecycle from `container-runner.ts`'s local-Docker assumption, so a runner can register itself and run anywhere; discussed 2026-08-15, not started, depends on session-sync landing first
4. [`.ics` generation + attachment-level handling](roadmap/ics-handling.md) — ingestion is done (Routine's calendar shims); narrowed 2026-09-19 to what's still actually unbuilt: generating/writing `.ics` files, and parsing calendar invites arriving as attachments
5. [Email handling](roadmap/email-handling.md) — a `/add-resend` skill exists (channels branch) but isn't installed/wired in this install as of 2026-09-19
6. [Post-turn topics agent, driven by real MCP-shim tools](roadmap/topics-agent-mcp-shims.md) — discussed 2026-08-15, not started
7. [`routine` agent — reminders + calendar](roadmap/routine-agent.md) — built and wired 2026-09-16 (agent group, calendar mcp-shims, `ncl tasks` via `cli_scope: group`, description, destinations both directions with Dispatcher); a2a delegation confirmed working live
8. [`Travel` agent + "leave now" reminders](roadmap/travel-agent-leave-now.md) — collaborates with `routine` to calculate travel time, add an offset, double-check closer to departure, notify Lumen when to leave, boop at T-5 and at meeting start; discussed 2026-09-16, not started; a working standalone travel-time shim already exists independent of the blocked Mapbox plan
9. [`assign_task` follow-ups](roadmap/task-id-routing-spike.md) — dedicated per-task a2a sessions + gated report_completion closure shipped 2026-09-16; still open (confirmed unbuilt 2026-09-19): `agent_tasks` ledger, shared intermediate-data folder, `work_status`/staleness detection, closed-session archival/cleanup
10. [`--stateless` scheduled tasks](roadmap/stateless-scheduled-tasks.md) — `ncl tasks create/update --stateless` skips transcript resume entirely for a recurring task whose work is fully self-contained each fire; shipped 2026-09-16, Routine's 4 calendar-check series flipped on and verified live; still open (confirmed 2026-09-19): extend the instruction to other task-creating agent groups (only Routine's has it), surface the flag in `ncl tasks get/list` output (only `create`/`update` take it so far)
11. [`routine` — daily-note awareness](roadmap/routine-daily-notes.md) — auto-injected access to today's Obsidian daily note via a new per-agent-group `wake_script` mechanism (covers both scheduled-task and a2a `assign_task` wakes) plus `daily_note_read`/`daily_note_append` MCP tools; built and verified live 2026-09-18; also holds two not-yet-scoped follow-on ideas (folding the note into Lumen's own briefing, letting `routine` edit existing note content)

12. [Fresh-install gaps](roadmap/fresh-install-gaps.md) — backup/restore scripts + [docs/fresh-install.md](fresh-install.md) written 2026-09-23 (syntax-checked, not yet run); open: PrefixRouter and the vault have no git remote, `~/.local/bin` tool origins unrecorded, restore unverified end to end

## Closed 2026-09-22

- **`routine` — detect and resolve Routine-added vs. authoritative calendar conflicts** —
  shipped end-to-end and verified against real vault data. When a note routine added to
  its local calendar copy turns out to also exist on the real upstream calendar (added
  independently), `calendar_conflict_scan` finds the collision (same local day, time
  overlap or near-start, or same-day all-day) and appends the authoritative note's
  wikilink to the routine note's `conflicts-with` list the moment it's surfaced (a list,
  not a single link — "potentially many," per David). Resolution: `calendar_note_append`
  merges routine's notes onto the authoritative record, then `calendar_personal_delete`
  soft-deletes routine's copy (`status: "deleted"`, required reason appended,
  `DELETED-`-prefixed filename — never a real file delete). Unsure → escalates to Lumen
  (a2a) → David, via routine's existing prompt/persona, no new mechanism. Trigger: a new
  stateless task (`calendar-conflict-check-8b4f`, Routine) chained after the vault's
  hourly `sync.js` cron via `ncl tasks run`, not an independent schedule ("multiple tasks
  stepping on each other's toes seems like a terrible idea" — David) — caught and fixed a
  cron-`PATH` gotcha (`ncl` execs `pnpm`, not on cron's default `PATH`) before wiring, with
  a crontab backup taken first. Also fixed the `_index.md` dataview query along the way:
  excludes `status: "deleted"`, shows event title + time range instead of the bare
  filename, backfilled across all 95 existing day folders. One real bug caught during
  testing: the `conflicts-with` list parser initially matched the frontmatter's own
  closing `---` as a bogus list entry — fixed by requiring real indentation before the
  dash. See `docs/mcp-shims-inventory.md`'s `routine` section for the tool list.

- **`routine` — read/edit calendar via the vault's local copy** — shipped: `calendar_personal_today/tomorrow/week` now read the vault's local `07-Daily/Calendar/{Y}/{M}/{D}/*.md` mirror (syncing it inline via `sync.js --days=N` first) instead of the live ICS feed, which was removed outright (`fetch-calendar.ts`/`ics-events.ts` deleted). Added `calendar_personal_add`/`calendar_personal_edit` for routine's own local-only events. One correction to this item's own prior investigation, found live during testing: the doc had assumed sync.js's staleness sweep only touches notes matching an upstream event's own `uid`, but `cancelStale` actually cancels *any* note whose `kind` is in `config.json`'s tracked kinds list (just `["personal"]`) if its key isn't in that sync run's fetch results — a routine-added `kind: "personal"` note got cancelled by the very next sync call. Fixed by giving routine-owned notes `kind: "routine"` instead, outside the tracked-kinds list (`sync.js` itself untouched). See `docs/mcp-shims-inventory.md`'s `routine` section for the current tool list.

## Closed 2026-09-19 (roadmap-staleness sweep)

Dispatched one research agent per item above to check current state against the codebase. Three items were fully resolved and removed rather than left stale:

- **Dispatcher agent infrastructure** — its "still open: give it a specialist to route to" gap was closed by item 7 (`routine`) the same day it was written, then further exercised by item 9's `assign_task` mechanism. Continuous live use since confirmed via git log and this session's own delivery.ts investigation.
- **Task handling** — its "scope TBD" ambiguity was resolved by `routine-agent.md`'s own clarification distinguishing `ncl tasks` (the real scheduler) from `mcp-shims/lumen-dmj/task_management/` (vault to-do capture, a different thing despite the name). Its one live thread (whether `task_management` should migrate to `routine`) is already tracked in `routine-agent.md`'s own open-items list.
- **`wikilink-query`** — the v1 shim this asked to re-implement or drop is superseded by `mcp-shims/lumen-dmj/vault/read_wikilink.ts`, built 2026-08-05/10, which resolves wikilinks (brackets, aliases, headings, block refs) more thoroughly than the described v1 scope.
