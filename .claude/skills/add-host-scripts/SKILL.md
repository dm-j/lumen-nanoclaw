---
name: add-host-scripts
description: Let a container agent invoke a whitelisted host-side script by name, per agent group, with structural isolation between groups. Fork-specific feature (lumen-nanoclaw), not upstream NanoClaw. Internally called "host-shim" in code/table/column names — this skill is the same thing under a clearer name.
---

# Add Host Scripts

Lets a container agent ask the host to run a specific, named script that
lives on the host filesystem — outside any container, with real access to
whatever the host itself can reach (a running desktop app, a mounted
drive, a local model server, anything a container can't touch). The agent
never gets shell access to the host; it can only invoke a script that
already exists, by name, in *its own agent group's* whitelist folder.

**Naming note:** the code calls this mechanism "host-shim" throughout
(`src/modules/host-shim/`, `container_configs.host_shims_dir`,
`execHostShim`, the `host-shim` CLI binary inside the container) — that
name predates this skill and is left as-is to avoid a churny rename across
tables/functions/binaries for no functional gain. This skill's own name
("host scripts") is meant to read clearly to a semi-technical operator
who's never seen the code; use whichever name is clearer in conversation.

## Why one whitelist folder per agent group

An earlier version of this mechanism used one global whitelist folder
shared by every agent group — any group could invoke any script sitting in
it. Here, each agent group resolves its **own** whitelist folder
(`container_configs.host_shims_dir`, defaulting to
`groups/<folder>/host-shims/`) — a script in one group's folder is
structurally invisible to every other group. A shared "household" group
can be pointed at a folder containing broader-access scripts (e.g. one
that reads several people's vaults) without any individual group gaining
access to it, purely by which folder it's configured to resolve.

## What it's used for today

This fork's `add-projected-sessions` skill depends on this mechanism: its
`briefing-host` script (seeded automatically into every new group's
`host-shims/` folder by `initGroupFilesystem`) is invoked by the host, not
the agent, but through the exact same whitelist-and-execute machinery. An
agent can also invoke any host script directly mid-turn — same lookup,
same isolation.

## Pre-flight

### Check if already applied

```bash
test -d src/modules/host-shim && grep -q "host_shims_dir" src/types.ts && echo "ALREADY APPLIED — skip to Verify"
```

### Verify the registry branch is reachable

```bash
git fetch origin host-shim && git log -1 --oneline origin/host-shim
```

## Apply

### 1. Copy the module, its container-side CLI, and the default template in

```bash
mkdir -p src/modules/host-shim src/host-shim-templates
for f in \
  src/modules/host-shim/exec.ts \
  src/modules/host-shim/exec.test.ts \
  src/modules/host-shim/guard.ts \
  src/modules/host-shim/index.ts \
  src/host-shim-templates/briefing-host \
  src/db/migrations/021-host-shims-dir.ts \
  container/agent-runner/src/cli/host-shim.ts \
; do
  mkdir -p "$(dirname "$f")"
  git show origin/host-shim:"$f" > "$f"
done
chmod +x src/host-shim-templates/briefing-host
```

### 2. Register the migration

Edit `src/db/migrations/index.ts` — add the import after `020-container-config-timezone`:

```typescript
import { migration021 } from './021-host-shims-dir.js';
```

...and the array entry after `migration020`:

```typescript
  migration020,
  migration021,
```

### 3. Register the module

Edit `src/modules/index.ts` — add, after the `self-mod` import:

```typescript
import './host-shim/index.js';
```

### 4. Add `host_shims_dir` to the container-config type + row

Edit `src/types.ts` — add to `ContainerConfigRow`, after `timezone`:

```typescript
  host_shims_dir: string | null; // NULL = default to groups/<folder>/host-shims/
```

Edit `src/db/container-configs.ts`:
- Add `'host_shims_dir'` to the `SCALAR_COLUMNS` set.
- Add `host_shims_dir`/`@host_shims_dir` to `createContainerConfig`'s
  `INSERT` column list and `VALUES` list, after `timezone`/`@timezone`.
- Add `| 'host_shims_dir'` to the `Pick<...>` union in
  `updateContainerConfigScalars`'s signature.

Edit `src/backfill-container-configs.ts` — add `host_shims_dir: null,` to
the row literal, after `timezone: null,`.

Any test fixture constructing a full `ContainerConfigRow` literal needs
`host_shims_dir: null,` added too — `tsc --noEmit -p .` will point at each
one that's missing it.

### 5. Add the trunk-owned templates directory constant

Edit `src/config.ts` — add, after `TEMPLATES_DIR`:

```typescript
// Trunk-owned default host-shim scripts (e.g. briefing-host), copied into a
// new group's own host-shims/ once at group-init time. Not runtime-overridable
// — unlike TEMPLATES_DIR, these aren't user-authored, they're shipped assets.
export const HOST_SHIM_TEMPLATES_DIR = path.resolve(PROJECT_ROOT, 'src', 'host-shim-templates');
```

### 6. Seed every new group with the default script

Edit `src/group-init.ts`:
- Add `HOST_SHIM_TEMPLATES_DIR` to the `./config.js` import.
- In `initGroupFilesystem`, add (near where `instructions.prepend.md` is seeded):

```typescript
  // host-shims/ — this group's own host-shim whitelist directory (default
  // location per resolveHostShimsDir; container_configs.host_shims_dir can
  // override it). Seeded with the default briefing-host script
  // (src/host-shim-templates/briefing-host), copied once and never
  // overwritten again — a group's own edits (e.g. its VAULT_PATH) must
  // survive every future spawn/restart.
  const hostShimsDir = path.join(groupDir, 'host-shims');
  if (!fs.existsSync(hostShimsDir)) {
    fs.mkdirSync(hostShimsDir, { recursive: true });
    initialized.push('host-shims/');
  }
  const briefingHostDst = path.join(hostShimsDir, 'briefing-host');
  const briefingHostSrc = path.join(HOST_SHIM_TEMPLATES_DIR, 'briefing-host');
  if (!fs.existsSync(briefingHostDst) && fs.existsSync(briefingHostSrc)) {
    fs.copyFileSync(briefingHostSrc, briefingHostDst);
    fs.chmodSync(briefingHostDst, 0o755);
    initialized.push('host-shims/briefing-host');
  }
```

### 7. Expose `--host-shims-dir` on `ncl groups config update`

Edit `src/cli/resources/groups.ts`:
- Add `host_shims_dir: row.host_shims_dir,` to `presentConfig`.
- Add a `parseHostShimsDirFlag` helper (undefined = not passed, `''` →
  `null` = explicit clear back to the default, otherwise the given path):

  ```typescript
  function parseHostShimsDirFlag(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    const dir = String(value);
    return dir === '' ? null : dir;
  }
  ```
- Add `'host_shims_dir'` to the `config update` handler's `Pick<...>` union.
- Append to the description string:
  `'--host-shims-dir (path to this group\'s host-shim whitelist directory; "" clears back to the default groups/<folder>/host-shims/).'`
- Add the parse block (after the `--timezone` block):
  ```typescript
  const hostShimsDirFlag = args['host-shims-dir'] ?? args.host_shims_dir;
  const hostShimsDir = parseHostShimsDirFlag(hostShimsDirFlag);
  if (hostShimsDir !== undefined) updates.host_shims_dir = hostShimsDir;
  ```
- Add `--host-shims-dir` to the "nothing to update" error message's flag list.

### 8. Container side: the `host-shim` CLI binary

The container-side file (`container/agent-runner/src/cli/host-shim.ts`,
copied in step 1) is self-contained — no imports from the rest of
agent-runner, same DB-transport pattern as `ncl.ts`. Wire it up in
`container/Dockerfile`, right after the existing `ncl` wrapper:

```dockerfile
# ---- host-shim CLI wrapper -----------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/host-shim.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/host-shim.ts "$@"\n' > /usr/local/bin/host-shim && \
    chmod +x /usr/local/bin/host-shim
```

### 9. Build, test, rebuild image

```bash
pnpm exec tsc --noEmit -p .
pnpm test
./container/build.sh
```

### 10. Record this in the fork's recipe

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

grep -q 'add-host-scripts' .claude/skills/recipe/SKILL.md || \
  echo "- [add-host-scripts](../add-host-scripts/SKILL.md) — applied $(date +%F) — per-agent-group whitelisted host script execution; prerequisite for add-projected-sessions" \
  >> .claude/skills/recipe/SKILL.md
```

## Wire a group

Every new group gets a `briefing-host` template automatically
(step 6) — nothing to run for the default case. To point a group at a
different whitelist folder (e.g. a shared group with broader-access
scripts):

```bash
ncl groups config update --id <group-id> --host-shims-dir /path/to/folder
ncl groups restart --id <group-id>
```

## Customization levers

| Lever | Where | What it changes |
|---|---|---|
| Per-group whitelist folder | `ncl groups config update --host-shims-dir <path>` | Which folder a group's scripts resolve from. `""` clears back to the default `groups/<folder>/host-shims/`. Lets one group (e.g. a shared household group) run differently-scoped scripts than any individual group, without cross-group access. |
| Which scripts exist | Drop or remove a `<name>-host` executable file directly in a group's whitelist folder | The whitelist **is** the filesystem — add a tool by dropping a script in, remove one by deleting it. No DB table of allowed names, no per-script config entry. |
| Call timeout | `TIMEOUT_MS` in `src/modules/host-shim/exec.ts` (code constant, default 30s) | How long the host waits for any host-shim call before giving up. `execHostShim` also accepts a per-call override (used by `add-projected-sessions`'s longer-running compiler calls and `add-host-cron`'s digester-style jobs) — most scripts don't need one. |
| Output size | `MAX_BUFFER` in `exec.ts` (code constant, 1MB) | Cap on captured stdout/stderr from a host script. |
| Default `briefing-host` template | `src/host-shim-templates/briefing-host` | Edit the shipped template itself to change what *every newly created group* starts with (existing groups' copies are never overwritten). |

## Troubleshooting

- **Agent says a tool/script "doesn't exist" or gets a permission-denied-style refusal.** Confirm the script is at `groups/<folder>/host-shims/<name>-host` (exact suffix `-host`), is executable (`chmod +x`), and isn't a symlink escaping the whitelist folder — `resolveShimPath` in `exec.ts` refuses anything that resolves outside the folder.
- **A group's `briefing-host` refuses to run with a "VAULT_PATH not configured" message.** Expected — the seeded template ships with a placeholder path and refuses to run until it's edited (`groups/<folder>/host-shims/briefing-host`). Edit it in place; it's never overwritten again once present.
- **Changed `--host-shims-dir` but the group still uses the old folder.** Restart the group (`ncl groups restart --id <group-id>`) — same as any other `container_configs` change.
- **A call that should be quick hangs for the full timeout.** Check the script isn't waiting on interactive input — `execFile` runs it non-interactively with no shell; anything expecting a TTY or a prompt will hang until `TIMEOUT_MS`.

## Verify

```bash
ls -la groups/<folder>/host-shims/
```

Should show at least `briefing-host` for any group that's been through
`initGroupFilesystem` since this skill was applied. From inside a running
container: `host-shim briefing <prev-file> <batch-file>` (or whatever
script/args you've placed there) exercises the same path an agent or the
host itself would use.

## Removal

See [REMOVE.md](REMOVE.md). Note: `add-projected-sessions` depends on this
mechanism — remove that skill first if it's applied, or its `briefing-host`
calls will start failing closed (which is safe, but check nothing needs it
before pulling this out).
