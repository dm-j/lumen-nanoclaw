---
name: add-projected-sessions
description: Add an opt-in 'projected' session lifecycle as a self-contained module — a host-side briefing compiler + prefix-cache-aware literal tail replace provider transcript resume, per agent group. Fork-specific feature (lumen-nanoclaw), not upstream NanoClaw.
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

The feature ships as a self-contained module (`src/modules/projected-sessions/`)
plus small, targeted touches to a handful of core files — each one an
established extension point this codebase already uses for optional
modules (a `hasTable`-gated hook, a barrel self-registration import, a
migration registration). Source: `feat/projected-sessions-v2` on this
fork's `origin` (`dm-j/lumen-nanoclaw`) — diff it directly if you'd rather
apply the whole thing at once:

```bash
git diff lumen-refresh origin/feat/projected-sessions-v2
```

This is a **fork-specific feature**, not something to upstream — it depends
on `/add-host-scripts`'s per-group whitelist mechanism (already in this
fork's trunk, not upstream NanoClaw).

## Pre-flight

### Verify `/add-host-scripts` is applied

This skill's compiler step is a host-script call — `execHostShim(agentGroupId,
'briefing', ...)`.

```bash
test -f src/modules/host-shim/exec.ts && test -f src/host-shim-templates/briefing-host && echo OK
```

If missing, run `/add-host-scripts` first — this skill depends on it.

### Verify the registry branch is reachable

```bash
git fetch origin feat/projected-sessions-v2 && git log -1 --oneline origin/feat/projected-sessions-v2
```

### Check if already applied

```bash
test -d src/modules/projected-sessions && echo "ALREADY APPLIED — skip to Verify"
```

## Apply

### 1. Copy the self-contained module in

```bash
mkdir -p src/modules/projected-sessions
for f in \
  src/db/migrations/025-projected-sessions.ts \
  src/modules/projected-sessions/db.ts \
  src/modules/projected-sessions/literal-tail.ts \
  src/modules/projected-sessions/compile-briefing.ts \
  src/modules/projected-sessions/synthesize.ts \
  src/modules/projected-sessions/index.ts \
  container/agent-runner/src/projected-sessions.ts \
; do
  git show origin/feat/projected-sessions-v2:"$f" > "$f"
done
```

All new files — copying overwrites, so re-running this step is safe.

### 2. Register the migration

Edit `src/db/migrations/index.ts` — add the import after `021-host-shims-dir`:

```typescript
import { migration025 } from './025-projected-sessions.js';
```

...and the array entry after `migration021`:

```typescript
  migration021,
  migration025,
```

### 3. Register the module

Edit `src/modules/index.ts` — add, after the `host-shim` import:

```typescript
import './projected-sessions/index.js';
```

### 4. Wire the per-wake hook

Edit `src/container-runner.ts`'s `spawnContainer`, right after the existing
`agent_destinations` block:

```typescript
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Compiled briefing + literal tail for projected-lifecycle sessions —
  // module is optional, skip when its table is absent. Reads the pending
  // batch straight from inbound.db (already written by writeSessionMessage
  // before wakeContainer was called), so this needs nothing from the
  // router-level event.
  if (hasTable(getDb(), 'projected_sessions_enabled')) {
    const { maybeSynthesizeProjectedContext } = await import('./modules/projected-sessions/synthesize.js');
    await maybeSynthesizeProjectedContext(agentGroup.id, session.id);
  }
```

### 5. Bump host-shim's timeout ceiling for long-running compiler calls

Real briefing-compiler calls run 20-90s — the shared host-shim default
(30s) is sized for cheap scripts. Edit `src/modules/host-shim/exec.ts`:

```typescript
export function execHostShim(
  agentGroupId: string,
  name: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<ShimResult> {
  // ...unchanged body...
  execFile(
    shimPath,
    args,
    { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf-8' },
    // ...
```

Every existing caller keeps the old 30s default; only `compile-briefing.ts`
(copied in step 1) passes a longer one.

### 6. Container side: gate resume, prepend the briefing

Edit `container/agent-runner/src/poll-loop.ts`:
- Add `import { isProjectedSession } from './projected-sessions.js';` at the top.
- At the start of `runPollLoop`, add `const projected = isProjectedSession();`
  and change the continuation-load line to
  `let continuation: string | undefined = projected ? undefined : migrateLegacyContinuation(config.providerName);`
- Gate the continuation-store call inside the try block:
  `if (!projected && result.continuation && result.continuation !== continuation) { ... }`
- Gate the other `setContinuation` call site (inside `processQuery`, on the
  `'init'` event): `if (!isProjectedSession()) setContinuation(providerName, event.continuation);`
  (a fresh check, not the `runPollLoop`-scoped `projected` — `processQuery`
  is a separate function).

Edit `container/agent-runner/src/formatter.ts`:
- Add `import { projectedContextHeader } from './projected-sessions.js';`
- Change `formatMessages`'s header line to:
  ```typescript
  const header = `${projectedContextHeader()}<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  ```

### 7. Build and test

```bash
pnpm exec tsc --noEmit -p .
pnpm test
```

Bun-side typecheck (`container/agent-runner/`) needs a `bun` binary — if
none is installed where you're applying this, that step is unverified;
run it manually before trusting `projected` mode:

```bash
cd container/agent-runner && bun run typecheck && bun test
```

### 8. Rebuild the container image

```bash
./container/build.sh
```

### 9. Record this in the fork's recipe

This fork tracks its accumulated customizations as a recipe ledger
(`.claude/skills/recipe/SKILL.md`, per `docs/skills-model.md`'s "a fork is
a recipe of skills"). Create it if it doesn't exist yet, and append this
skill's entry — skip if an entry for `add-projected-sessions` is already
there (idempotent, safe to re-run):

```bash
mkdir -p .claude/skills/recipe
if [ ! -f .claude/skills/recipe/SKILL.md ]; then
  cat > .claude/skills/recipe/SKILL.md <<'RECIPE_EOF'
---
name: recipe
description: This fork's applied-customizations ledger — every skill applied to this install, in apply order, with its source and why. Read before /update-nanoclaw or handing this fork to someone else; append to it whenever another skill's Apply steps say to.
---

# Recipe

Per `docs/skills-model.md`: "A fork is a recipe of skills... one 'recipe'
skill lists all your skills and how they fit together." This file is that
list for this install. It's what lets this fork be rebuilt from clean
upstream, or handed to someone else, without reconstructing "what did I
change" from memory or commit archaeology.

**This is a ledger, not a script.** Applying an entry means running that
skill's own Apply steps (or diffing its source branch) — this file just
records that it happened, in what order, and why.

## Applied skills

<!-- Each entry: - [skill-name](../skill-name/SKILL.md) — applied YYYY-MM-DD — one-line why -->
RECIPE_EOF
fi

grep -q 'add-projected-sessions' .claude/skills/recipe/SKILL.md || \
  echo "- [add-projected-sessions](../add-projected-sessions/SKILL.md) — applied $(date +%F) — opt-in briefing-compiler session lifecycle, per agent group" \
  >> .claude/skills/recipe/SKILL.md
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
| Compiler call timeout | `COMPILE_TIMEOUT_MS` in `src/modules/projected-sessions/compile-briefing.ts` (code constant, default 120s) | How long the host waits for a `briefing-host` call before falling back to the previously stored briefing. Real subagent-backed compilers run 20-90s; raise this if yours legitimately runs longer, lower it to fail over faster. |
| Compiler's own literal-tail size | `COMPILER_TAIL_TURNS` in `compile-briefing.ts` (code constant, default 6) | How much recent conversation the compiler itself sees, on top of whatever it looks up fresh. Small on purpose — too much crowds out what it's supposed to be citing. |
| Responder's literal-tail size | `RESPONDER_TAIL_TURNS` in `src/modules/projected-sessions/synthesize.ts` (code constant, default 40) | How much recent conversation the responder sees verbatim, independent of the briefing. This is the responder's real working-context window in projected mode. |
| Literal-tail safety cap | `SAFETY_CAP` in `src/modules/projected-sessions/literal-tail.ts` (default 500) | Hard ceiling on how much history a single anchor-growth cycle reads or holds, regardless of the N values above — protects a long-lived agent-shared session from an unbounded per-turn scan. |
| Pending-batch read cap | `BATCH_READ_CAP` in `src/modules/projected-sessions/db.ts` (default 50) | Max number of pending inbound messages folded into what the compiler sees as "the new batch" for one wake. |

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
  `container-runner.ts` never ran (step 4 wasn't applied, or the migration
  wasn't registered).
- **Compiler call times out.** Default ceiling is 120s
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
