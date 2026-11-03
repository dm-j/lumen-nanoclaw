---
name: add-projected-sessions
description: Use when the user wants to enable projected sessions (briefing-based context instead of provider transcript resume) for an agent group.
---

# Add Projected Sessions (Briefing Compiler)

Adds a second session lifecycle, opt-in per agent group via
`ncl projected-sessions enable --id <group-id>`. Default behavior — the
responder resumes its own ever-growing provider transcript every turn —
is untouched for every group that doesn't opt in.

In `projected` mode, the responder never resumes. Instead, on every wake:

1. The host runs this group's `briefing-host` shim (a `claude -p --agent
   briefer` subagent by default) against the previous rolling briefing +
   the new inbound batch, producing an updated briefing.
2. The host reads a literal recent-turns tail straight from
   `messages_in`/`messages_out`.
3. Both are written to the session dir (`briefing.md`, `recent-turns.md`)
   — the same host path already mounted at `/workspace` in the container.

The container's formatter prepends these as `<briefing>`/`<recent-turns>`
blocks ahead of the normal `<context>` header, and the poll loop never
loads or persists a provider continuation for this session. No changes
anywhere in `container/agent-runner/src/providers/`.

Both the compiler's own tail and the responder's tail grow with a
prefix-cache-aware anchored scheme (`N → 2N → truncate`, not a naive
sliding window) so repeated turns hit Anthropic's prompt cache on the
literal-tail block instead of missing it every time.

Installed by **`/add-memory-stack`** (this skill no longer carries its own
copy/patch steps — projected sessions, the vault transcript export and
attachment captioning share edits in the same functions and are applied as one
unit). It depends on `/add-host-scripts` (the `briefing-host` shim and its
whitelist mechanism). This is a **fork-specific feature**, not something to
upstream.

```bash
test -f src/modules/projected-sessions/synthesize.ts && grep -q projected_sessions_enabled src/container-runner.ts && echo "installed"
```

## Wire a group

```bash
ncl projected-sessions enable --id <group-id>
ncl groups restart --id <group-id>
```

The group needs a `briefing-host` in its host-shim whitelist folder
(`groups/<folder>/host-shims/briefing-host` by default). `group-init.ts`
seeds the default template (`src/host-shim-templates/briefing-host`) for
every new group, but it needs `VAULT_PATH` edited before it'll actually run.

```bash
ncl projected-sessions status --id <group-id>
ncl projected-sessions list
```

## Customization levers

Everything below is a lever this feature exposes, where it lives, and what
tuning it actually changes. None of these need code changes to use except
the two marked "code constant" — those are deliberately not exposed as
`ncl` flags yet (no observed need), but are one-line edits if you outgrow
the default.

| Lever | Where | What it changes |
|---|---|---|
| Per-group on/off | `ncl projected-sessions enable\|disable --id <group-id>` | Whether this group uses the projected lifecycle at all. Everything else below only matters for enabled groups. |
| The compiler itself | `groups/<folder>/host-shims/briefing-host` (per group) | This is the real customization point — a plain script, so it can be anything: a different subagent, a different vault/data source, a different model, no LLM call at all. The default template shells to `claude -p --agent briefer`; a group can replace it outright. Different groups can run entirely different scripts (e.g. a shared "household" group's script reading a curated slice of several people's vaults, vs. an individual's own full-access script) — same per-group whitelist isolation `/add-host-scripts` provides for any script, not just this one. |
| Which whitelist folder a group's `briefing-host` is resolved from | `ncl groups config update --host-shims-dir <path>` (`/add-host-scripts`'s own lever, reused here) | Lets a shared group point at a differently-scoped script than any individual group, without individual groups gaining access to it. |
| Compiler call timeout | `COMPILE_TIMEOUT_MS` in `src/modules/projected-sessions/compile-briefing.ts` (code constant, default 300s) | How long the host waits for a `briefing-host` call before falling back to the previously stored briefing. Real subagent-backed compilers run 20-90s (slower through PrefixRouter/Ollama); raise this if yours legitimately runs longer, lower it to fail over faster. |
| Compiler's own literal-tail size | `COMPILER_TAIL_TURNS` in `compile-briefing.ts` (code constant, default 5) | How much recent conversation the compiler itself sees, on top of whatever it looks up fresh. Small on purpose — too much crowds out what it's supposed to be citing. Also the cap on the briefing history the compiler sees (the responder keeps its own, `RESPONDER_BRIEFING_CAP` in `synthesize.ts`, default 2). The tail grows anchored from N up to 2N turns before resetting (see `literal-tail.ts`). |
| Responder's literal-tail size | `RESPONDER_TAIL_TURNS` in `src/modules/projected-sessions/synthesize.ts` (code constant, default 12) | How much recent conversation the responder sees verbatim, independent of the briefing. This is the responder's real working-context window in projected mode. Same N→2N anchored growth as the compiler's tail. |
| Briefing history kept in context | `BRIEFING_HISTORY_CAP` in `compile-briefing.ts` (code constant, default 3; shared by compiler and responder) | How many past briefings the responder sees interleaved by timestamp with the raw turns. Raised 2→3 on 2026-11-03. |
| Literal-tail safety cap | `SAFETY_CAP` in `src/modules/projected-sessions/literal-tail.ts` (default 500) | Hard ceiling on how much history a single anchor-growth cycle reads or holds, regardless of the N values above — protects a long-lived agent-shared session from an unbounded per-turn scan. |
| Pending-batch read cap | `BATCH_READ_CAP` in `src/modules/projected-sessions/db.ts` (default 50) | Max number of pending inbound messages folded into what the compiler sees as "the new batch" for one wake. |
| Warm-container follow-up reset | `PROJECTED_FOLLOWUP_RESET_COUNT` (12) and `PROJECTED_QUERY_FALLBACK_TTL_MS` (5 min) in `container/agent-runner/src/poll-loop.ts` (code constants; independent of the tail sizes above; the cache-TTL check asks PrefixRouter's `/cache-status` first and only falls back to the local TTL guess) | A warm container pushes follow-ups into one open model query, which keeps growing. When either limit is hit the container exits (code 75, `PROJECTED_QUERY_RESET` in its stderr) and the host respawns it with a fresh, small briefing/tail. Duplicated in the container because `container/agent-runner` can't import host `src/`. See `docs/roadmap/warm-container-context-accumulation.md`. |

## Troubleshooting

- **`ncl projected-sessions enable` succeeds but the agent still seems to
  have full history.** Restart the group — same as any other lifecycle
  change here (`ncl groups restart --id <group-id>`).
- **Agent gets no briefing/tail at all.** Check the group has a
  `briefing-host` shim: `ls groups/<folder>/host-shims/`. If missing or not
  executable, the compiler fails closed silently (falls back to the last
  stored briefing, or empty on a first turn) — check `logs/nanoclaw.log`
  for `compile-briefing: falling back to stored briefing` and read the
  logged `stderr`/`exitCode`. Also check
  `groups/<folder>/.projected-sessions-enabled` exists — if it's missing
  even after enabling + restarting, the `hasTable` hook in
  `container-runner.ts` never ran (`add-memory-stack`'s patch wasn't applied, or the migration
  wasn't registered).
- **Compiler call times out.** Default ceiling is 300s
  (`COMPILE_TIMEOUT_MS` in `compile-briefing.ts`) — a real `claude -p`
  subagent call runs 20-90s normally. Fails closed either way.
- **`session_briefings` grows without bound.** Expected for now — this
  skill doesn't include compaction. Not urgent for a single small `TEXT`
  column; revisit if a session runs for a very long time without ever
  resetting its briefing.
- **Bun typecheck/tests not run.** Documented limitation of this write-up
  — the container-side edits (step 6) were reviewed but not run through
  Bun's own toolchain when this skill was authored. Run
  `cd container/agent-runner && bun run typecheck && bun test` yourself
  before trusting `projected` mode in production.

## Verify

Send a message to an enabled group and confirm:

```bash
tail -50 logs/nanoclaw.log | grep -i briefing
ls -la groups/<folder>/.projected-sessions-enabled
ls -la data/v2-sessions/<agent-group-id>/<session-id>/briefing.md data/v2-sessions/<agent-group-id>/<session-id>/recent-turns.md
```

A real end-to-end test against a live agent group hasn't been run yet as
of this skill's authoring — do this before relying on the feature.

## Removal

See [REMOVE.md](REMOVE.md). Reverts every code change; does **not** roll
back the migration (this project's migrations are forward-only) —
removal just deletes the module and its two hook lines, leaving two dead
tables with no reader or writer.

## Credits & references

- Depends on: `/add-host-scripts` (per-agent-group whitelisted host script
  execution) — not present upstream.
