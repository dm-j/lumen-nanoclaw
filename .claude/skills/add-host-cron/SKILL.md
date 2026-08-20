---
name: add-host-cron
description: Schedule a host-shim script (add-host-scripts) to run on a cron schedule, per agent group, with no container spawn and no conversation cost. Fork-specific feature (lumen-nanoclaw), not upstream NanoClaw.
---

# Add Host Cron

Lets an agent group schedule a host-shim script to run on a cron
schedule, independent of any inbound message. No container spawn, no
conversation cost — the host just runs the named script directly, on
time, the same way `add-host-scripts` already lets a container agent run
one on demand.

This module has **zero opinion on what the script does** — it's purely
"run `<name>-host` for this agent group, on this schedule." Anything that
needs periodic host-side work (a vault export, a digest generation pass,
a cleanup task, a health check) is just another host-shim script pointed
at by a cron row.

**Depends on `/add-host-scripts`** — the scripts this schedules are
ordinary host-shim scripts; this skill only adds the clock.

## Pre-flight

### Verify `/add-host-scripts` is applied

```bash
test -f src/modules/host-shim/exec.ts && echo OK
```

If missing, run `/add-host-scripts` first.

### Check if already applied

```bash
test -d src/modules/host-cron && echo "ALREADY APPLIED — skip to Verify"
```

### Verify the registry branch is reachable

```bash
git fetch origin host-cron && git log -1 --oneline origin/host-cron
```

## Apply

### 1. Copy the module in

```bash
mkdir -p src/modules/host-cron
for f in \
  src/db/migrations/026-host-cron.ts \
  src/modules/host-cron/db.ts \
  src/modules/host-cron/db.test.ts \
  src/modules/host-cron/run.ts \
  src/modules/host-cron/index.ts \
; do
  git show origin/host-cron:"$f" > "$f"
done
```

### 2. Register the migration

Edit `src/db/migrations/index.ts` — add the import after `021-host-shims-dir`:

```typescript
import { migration026 } from './026-host-cron.js';
```

...and the array entry after `migration021`:

```typescript
  migration021,
  migration026,
```

### 3. Register the module

Edit `src/modules/index.ts` — add, after the `host-shim` import:

```typescript
import './host-cron/index.js';
```

### 4. Wire the tick into host-sweep

Edit `src/host-sweep.ts`:
- Add `import { getDb, hasTable } from './db/connection.js';` to the imports.
- In `sweep()`, right after the existing `MODULE-HOOK:approvals-reason-sweep:end`
  marker, add:

```typescript
  // Agent-group-scoped, not session-scoped — runs once per tick, not once
  // per active session. Module is optional; skip when its table is absent.
  // MODULE-HOOK:host-cron:start
  if (hasTable(getDb(), 'host_cron_jobs')) {
    try {
      const { runDueHostCronJobs } = await import('./modules/host-cron/run.js');
      await runDueHostCronJobs();
    } catch (err) {
      log.error('host-cron sweep failed', { err });
    }
  }
  // MODULE-HOOK:host-cron:end
```

Placement matters: after the per-session sweep loop, not inside it.

### 5. Ensure `execHostShim` accepts a per-call timeout

`host-cron`'s tick calls `execHostShim(agentGroupId, name, args, timeoutMs)`
— a 4th argument. Check whether your copy of `src/modules/host-shim/exec.ts`
already has it:

```bash
grep -q 'timeoutMs = TIMEOUT_MS' src/modules/host-shim/exec.ts && echo "already has it"
```

If not, edit `execHostShim`'s signature and its `execFile` call:

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

Backward-compatible — every existing caller keeps the old 30s default.

### 6. Build and test

```bash
pnpm exec tsc --noEmit -p .
pnpm exec vitest run src/modules/host-cron/db.test.ts
pnpm test
```

### 7. Record this in the fork's recipe

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

grep -q 'add-host-cron' .claude/skills/recipe/SKILL.md || \
  echo "- [add-host-cron](../add-host-cron/SKILL.md) — applied $(date +%F) — schedule host-shim scripts on a cron, no container spawn; foundation for the vault memory pipeline's export/digest jobs" \
  >> .claude/skills/recipe/SKILL.md
```

## Wire a job

```bash
ncl host-cron-jobs create --id <group-id> --name <script> --cron "<cron expr>" [--args '["a","b"]'] [--timezone <iana>]
ncl host-cron-jobs list --id <group-id>
ncl host-cron-jobs run --job-id <id>       # force-run now, then reschedules normally
ncl host-cron-jobs delete --job-id <id>
```

`<script>` must exist as `<script>-host` in that group's host-shim
whitelist folder (see `/add-host-scripts`).

## Customization levers

| Lever | Where | What it changes |
|---|---|---|
| Schedule | `ncl host-cron-jobs create --cron "<expr>"` | Standard 5-field cron, parsed by `cron-parser` (same library task recurrence uses). |
| Timezone | `--timezone <iana>` on create | Which wall-clock the cron grid is interpreted in. Omit to follow the group's own timezone (`resolveGroupTimezone`). |
| Args passed to the script | `--args '["a","b"]'` on create | Plain JSON string array, passed straight to the host-shim script. |
| Which scripts are schedulable | Any `<name>-host` in the group's host-shim whitelist folder | No separate registration — if `add-host-scripts` can run it on demand, `add-host-cron` can run it on a schedule. |
| Call timeout for scheduled runs | `LONG_RUNNING_PREFIXES`/`DEFAULT_TIMEOUT_MS`/`LONG_TIMEOUT_MS` in `src/modules/host-cron/run.ts` (code constants) | A job whose `name` starts with `digest` gets the longer (180s) timeout; everything else gets 60s. Simple name-prefix heuristic, not a per-job column — revisit if a job needs something in between. |
| Force a run without waiting for the schedule | `ncl host-cron-jobs run --job-id <id>` | Runs immediately, still reschedules normally afterward — useful for testing a new script. |

## Troubleshooting

- **`--cron` rejected at create time.** `cron-parser` validates eagerly —
  the error message is the parser's own, which is usually specific enough
  to fix directly (bad field count, out-of-range value).
- **Job never fires.** Confirm the migration actually ran
  (`sqlite3 data/v2.db "select name from schema_version where name='host-cron'"`
  or the equivalent `q.ts` wrapper) and that `src/host-sweep.ts` actually
  has the `MODULE-HOOK:host-cron` block — a partially-applied skill (module
  copied, hook not wired) leaves jobs created but never ticked.
- **Job fires but the script never runs / fails immediately.** This is a
  host-shim question, not a host-cron one — check `/add-host-scripts`'s own
  troubleshooting (whitelist folder, executable bit, symlink escape).
- **A failed run doesn't retry before the next scheduled fire.** By design
  — see "Customization levers" is silent on this because it's not a lever:
  there's no in-period retry/backoff. The next scheduled fire *is* the
  retry. If a job needs faster recovery than its own cron period, that's a
  signal the cron expression itself should be tighter, not that host-cron
  needs new retry logic.

## Verify

```bash
ncl host-cron-jobs list
```

Should show `next_run_at` in the future for every row. After a tick fires
one, `last_run_at` should update and `next_run_at` should have moved
forward. Check `logs/nanoclaw.log` for `host-cron job failed`/`host-cron
job threw` if a run doesn't seem to have done anything.

## Removal

See [REMOVE.md](REMOVE.md). Does **not** roll back the migration
(forward-only, like every migration here) — a leftover `host_cron_jobs`
table with no reader or writer is harmless. Delete any jobs first
(`ncl host-cron-jobs delete`) if you want a clean stop rather than just
removing the ticking mechanism out from under still-scheduled rows.
