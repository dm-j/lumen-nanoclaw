---
name: add-host-scripts
description: Use when the user wants an agent to be able to run a whitelisted host-side script, or mentions "host-shim", "host script", "mcp-shim" plumbing, "shim pool", or giving the agent host access.
---

# Add Host Scripts

Lets a container agent ask the host to run a specific, named script that
lives on the host filesystem — outside any container, with real access to
whatever the host itself can reach (a running desktop app, a mounted
drive, a local model server, anything a container can't touch). The agent
never gets shell access to the host; it can only invoke a script that
already exists, by name, in *its own agent group's* whitelist.

This one skill installs the whole **host-shim layer**, because its pieces
are entangled in the code and can't be applied separately:

- **host-shims** — scripts an agent calls by name through the `host-shim`
  CLI (Bash tool), or the host calls itself (`briefing-host`, vault export).
- **mcp-shims** — the same scripts surfaced as real MCP tools: the host
  discovers `<server>/<name>-host` scripts, materializes a manifest into
  `container.json`, and the container registers one generic tool per entry
  (`dynamic-shims.ts`). Building new ones: `add-mcp-shim`; background:
  `mcp-shims`.
- **shim pool + registry** — optional: scripts live once in
  `host-shims/_pool/` and `_registry.json` says which group may run which,
  with per-group env (e.g. `VAULT_PATH`). Groups not in the registry keep a
  private per-group directory.
- **default templates** — `src/host-shim-templates/` (briefing, transcript
  append, digests, recall, remember, inbox-triage, sqlite-corrupt-count).

**Naming note:** the code calls this mechanism "host-shim" throughout
(`src/modules/host-shim/`, `container_configs.host_shims_dir`,
`execHostShim`, the `host-shim` CLI binary inside the container) — that
name predates this skill and is left as-is. "Host scripts" is just the
operator-friendly name.

## How it isolates groups

The whitelist **is** the filesystem: a name is allowed iff an executable
`<name>-host` exists in the group's whitelist directory
(`host-shims/<folder>/`, a sibling of `groups/` and never mounted into any
container, or `container_configs.host_shims_dir` if set). A group can only
run scripts from its own whitelist, so a shared "household" group can be
pointed at broader-access scripts without any individual group gaining them.

With the **registry**, a group listed in `host-shims/_registry.json` instead
draws from the shared pool and gets *exactly* its allowlist:

```json
{ "<group folder>": { "<shim name>": { "ENV_VAR": "per-group value" } } }
```

host-shims use a plain name (`briefing`), mcp-shims use `<server>/<leaf>`;
both resolve to `_pool/<name>-host`. The env object is passed to the script;
pooled shims also get `NANOCLAW_AGENT_GROUP_ID` and a per-group
`NANOCLAW_SHIM_STATE_DIR` (`host-shims/_state/<folder>/`) for logs and
checkpoints. Groups outside the registry, or with a `host_shims_dir` /
`mcp_shims_dir` override, keep their private directory. A registry that
exists but can't be parsed denies everything. It is re-read on every call.

## Pre-flight

### Check if already applied

```bash
test -d src/modules/host-shim && test -f src/modules/host-shim/registry.ts && grep -q "host_shims_dir" src/types.ts && echo "ALREADY APPLIED — skip to Verify"
```

### Verify the branch is reachable

```bash
git fetch origin host-shim && git log -1 --oneline origin/host-shim
```

## Apply

The module-owned files live on the `host-shim` branch (list: `files.txt` in
this skill's folder). Edits to files NanoClaw owns are in
`shared-files.patch`, generated from a clean checkout of the fork's upstream
base and proven there (typecheck + full host and container test suites).

### 1. Copy the module-owned files in

```bash
while read -r f; do
  mkdir -p "$(dirname "$f")"
  git show "origin/host-shim:$f" > "$f"
done < .claude/skills/add-host-scripts/files.txt
chmod +x src/host-shim-templates/*-host
```

That is `src/modules/host-shim/` (exec, registry, mcp-manifest, guard, index
+ tests), all `src/host-shim-templates/*`, migrations `021-host-shims-dir`
and `029-mcp-shims-dir`, and the container side:
`container/agent-runner/src/cli/host-shim.ts` and
`container/agent-runner/src/mcp-tools/dynamic-shims.ts`.

> The container CLI on the branch has **no session-sync overlay**. This fork's
> trunk copy also handles the shelved `sync` transport (imports
> `./sync-outbound-push.js`); that is a separate, unapplied feature. If you
> ever apply session-sync, take trunk's `host-shim.ts` and `ncl.ts` instead.

### 2. Apply the shared-file patch

```bash
git apply --3way .claude/skills/add-host-scripts/shared-files.patch
```

`--3way` leaves conflict markers where upstream moved; resolve by intent
(table below), then `git add` the files. If the patch cannot apply at all,
make the edits by hand from the table.

| File | Edit |
|---|---|
| `src/types.ts` | `host_shims_dir` and `mcp_shims_dir` (`string \| null`) on `ContainerConfigRow` |
| `src/db/container-configs.ts` | both columns in `SCALAR_COLUMNS`, in `createContainerConfig`'s INSERT column and VALUES lists, and in `updateContainerConfigScalars`'s `Pick<...>` union |
| `src/backfill-container-configs.ts`, `src/db/db-v2.test.ts` | `host_shims_dir: null, mcp_shims_dir: null,` in row literals (let `tsc` find the rest) |
| `src/config.ts` | exports `HOST_SHIMS_DIR`, `MCP_SHIMS_DIR` (both honour `NANOCLAW_HOST_SHIMS_DIR` / `NANOCLAW_MCP_SHIMS_DIR`) and `HOST_SHIM_TEMPLATES_DIR` |
| `vitest.config.ts` | `test.env` points both overrides at a temp dir so tests never touch the real shim trees |
| `src/group-init.ts` | create `host-shims/<folder>/` and seed `briefing-host`, `transcript-append-host`, `digest-daily-host`, `digest-rollup-host` once (never overwrite); create `mcp-shims/<folder>/`; **skip both for groups in the registry** (`pooledShimsFor`) |
| `src/cli/resources/groups.ts` | `--host-shims-dir` / `--mcp-shims-dir` on `groups config update` (`""` clears) + both in `presentConfig` |
| `src/container-config.ts` | `ContainerConfig.mcpShims`; `materializeContainerJson` sets it from `discoverMcpShims` |
| `src/db/migrations/index.ts` | register `021-host-shims-dir` and `029-mcp-shims-dir` |
| `src/modules/index.ts` | `import './host-shim/index.js';` |
| `container/agent-runner/src/mcp-tools/index.ts` | `import './dynamic-shims.js';` |
| `src/provider-surfaces.test.ts` | `mcpShims: []` in its `ContainerConfig` fixture |
| `container/Dockerfile` | `host-shim` wrapper (`exec bun /app/src/cli/host-shim.ts "$@"`), after the `ncl` wrapper |

**Migration numbers and names.** Migrations are keyed on `name` (uniqueness
is on `name`; `version` is only an ordering hint within the barrel array),
so reusing a number upstream already uses is safe. Upstream's own
`021-approval-question` already shares number 21 with `021-host-shims-dir`:
import one under an alias (`migration021 as migration021ApprovalQuestion`)
and list both. On a newer upstream, if identifiers collide, alias the same
way — never rename an applied migration.

### 3. Build, test, rebuild image

```bash
pnpm exec tsc --noEmit -p .
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)
./container/build.sh
```

### 4. Record this in the fork's recipe

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
  echo "- [add-host-scripts](../add-host-scripts/SKILL.md) — applied $(date +%F) — host-shim layer: per-group/pooled whitelisted host scripts, mcp-shims manifest, templates; prerequisite for add-projected-sessions, add-host-cron and add-vault-memory-pipeline" \
  >> .claude/skills/recipe/SKILL.md
```

## Wire a group

New groups get the default templates automatically (unless registered). To
point a group at a different whitelist folder:

```bash
ncl groups config update --id <group-id> --host-shims-dir /path/to/folder   # "" clears
ncl groups restart --id <group-id>
```

To move a group onto the pool: put the scripts in `host-shims/_pool/`, add
the group's folder and allowlist to `host-shims/_registry.json`. No restart
needed (re-read per call).

## Customization levers

| Lever | Where | What it changes |
|---|---|---|
| Per-group whitelist folder | `ncl groups config update --host-shims-dir <path>` | Which folder a group's scripts resolve from. |
| Shared pool + allowlist | `host-shims/_pool/`, `host-shims/_registry.json` | One copy of each script, per-group allowlist and per-shim env. |
| Which scripts exist | Add/remove an executable `<name>-host` | The whitelist is the filesystem — no DB table of names. |
| Call timeout | `TIMEOUT_MS` / `timeoutFor` in `src/modules/host-shim/exec.ts`; an mcp-shim's `--help` JSON `timeoutMs`; `execHostShim`'s per-call override | How long the host waits (the container CLI waits 210 s). |
| Output size | `MAX_BUFFER` in `exec.ts` (1MB) | Cap on captured stdout/stderr. |
| Default templates | `src/host-shim-templates/*` | What newly created, unregistered groups start with (existing copies are never overwritten). |

## Troubleshooting

- **Agent says a tool/script "doesn't exist" or gets a permission-denied-style refusal.** Registered group: is the name in `_registry.json` and the script in `_pool/<name>-host`? Unregistered: is it at `host-shims/<folder>/<name>-host` (exact `-host` suffix), executable, and not a symlink escaping the whitelist (`resolveShimPath` refuses that)?
- **A shim refuses with "VAULT_PATH not configured".** Templates take `VAULT_PATH` from the environment (registry env) and otherwise ship a placeholder that refuses to run; set it in the registry entry, or edit the group's private copy.
- **Changed `--host-shims-dir` but the group still uses the old folder.** `ncl groups restart --id <group-id>`. (Registry edits need no restart.)
- **A call that should be quick hangs for the full timeout.** The script is waiting on input — `execFile` runs it non-interactively with no shell.
- **Registry edit has no effect.** A group with `host_shims_dir` / `mcp_shims_dir` set ignores the registry; an unparsable registry denies everything (check the host log).

## Verify

```bash
ls -la host-shims/<folder>/            # unregistered group
ls -la host-shims/_pool/ && cat host-shims/_registry.json   # pooled
```

From inside a running container: `host-shim briefing <prev-file> <batch-file>`
(or another script/args) exercises the same path an agent or the host uses.

## Removal

See [REMOVE.md](REMOVE.md). `add-projected-sessions`, `add-host-cron` and
`add-vault-memory-pipeline` depend on this mechanism — remove them first.
