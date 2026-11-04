# Instance repo split

`lumen-nanoclaw` (this repo) is the generic fork: skills, docs, `recipe`
ledger, host code. It carries no personal data by construction.

Everything specific to *this install* — personas, per-group config, and the
mcp-shims/host-shims scripts (which routinely hardcode things like a home
address or a local vault path) — lives in a separate private repo:

```
~/Projects/lumen-nanoclaw-instance/
  groups/
  mcp-shims/      _pool/  _registry.json  lib/  _state/   (+ legacy <group>/ dirs; mbif/ = the vault's own server root)
  host-shims/     _pool/  _registry.json  _state/         (+ legacy <group>/ dirs)
```

Scripts live once in each `_pool/`, and `_registry.json` says which group gets which (with per-group
env). Groups not yet in a registry keep a per-group directory. The mechanism is generic and lives in this
repo (`src/modules/host-shim/registry.ts`); the registry contents are instance data. See
[mcp-shims.md](mcp-shims.md#where-scripts-live).

In `lumen-nanoclaw`, `groups/`, `mcp-shims/`, and `host-shims/` are
**symlinks** into that repo. Runtime code (container mounts, `GROUPS_DIR`,
`MCP_SHIMS_DIR`, `HOST_SHIMS_DIR` in `src/config.ts`) reads/writes through
the symlink and doesn't need to know the split exists — Docker Desktop
resolves symlinks before bind-mounting, and `src/modules/host-shim/exec.ts`'s
symlink-escape check (`realpathSync` on both the candidate and the shims
dir) resolves consistently on both sides, so no runtime code changed.

The instance repo has a remote, `git@github.com:dm-j/lumen-instance.git` (private). Its commits are
made automatically by the hooks below and are **not pushed** by them, so its local branch can run well
ahead of `origin`; push it deliberately.

Installed by the `add-instance-repo` skill (`install.sh`, idempotent; `--migrate` moves existing
`groups/`/shim directories into the instance repo). `add-lumen-customizations` runs it first.

## How the two repos stay in step (hooks in `lumen-nanoclaw/.husky/`)

- **`pre-commit`**: after formatting, runs `git add -A` in the instance repo, so whatever changed there
  (a persona, a shim, a registry entry) is staged alongside the commit being made here. It unsets
  `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` first: in a worktree git exports them to hooks and they
  would otherwise stage the instance repo into *this* repo's index.
- **`post-commit`**: if the instance repo has staged changes, runs a backgrounded `claude -p` there that
  commits them as one commit with a real summary message (allowed tools: `git add/commit/status/diff`
  only; never pushes). The instance repo's own `.git/hooks/post-commit` then snapshots `data/*.db`.
- **`post-checkout`** (worktrees only): re-creates the three symlinks and runs a Node-22-pinned
  `pnpm install --frozen-lockfile`, and registers the worktree in `~/.claude/worktrees.json`.
- **Side effect of `pre-commit` on text files:** it strips zero-width characters and rewrites the em dash
  (U+2014) to a hyphen in every staged text file. Em dashes in committed code or docs will not survive
  a commit here.

`.gitignore` keeps the private areas out of this repo: `groups/*` (with the few tracked exceptions),
`/mcp-shims/`, `/host-shims/`. The hooks read `NANOCLAW_INSTANCE_REPO`, falling back to the path chosen when the skill was run
(here `/Users/lumen/Projects/lumen-nanoclaw-instance`).

## Rebuilding on a new machine

1. `git clone git@github.com:dm-j/lumen-instance.git ~/Projects/lumen-nanoclaw-instance`
2. In the NanoClaw checkout: `ln -s ~/Projects/lumen-nanoclaw-instance/{groups,mcp-shims,host-shims} .`
   (the `post-checkout` hook does this for worktrees only).
3. `data/*.db` is not in either repo; restore the newest `~/nanoclaw-db-backups/<timestamp>/` (or the
   encrypted nightly backup, see `docs/fresh-install.md`).
4. Re-apply the skills (`add-host-scripts` first: the shim pool, registry and `NANOCLAW_*_SHIMS_DIR`
   overrides that make this layout work are in it).

## DB backups

`data/*.db` stays untracked (SQLite doesn't diff well and churns every
commit). Instead, a `post-commit` hook in `lumen-nanoclaw-instance`
(`.git/hooks/post-commit`) copies `data/*.db` to
`~/nanoclaw-db-backups/<ISO-timestamp>/` on every commit to the instance
repo — a snapshot correlated with whatever config/persona change triggered
the commit, no git involved.

## Known gaps

- `groups/`, `mcp-shims/`, `host-shims/` were moved wholesale on 2026-08-07.
  The test-fixture-looking shim dirs in them (`bravo`, `newbie`, `surfy-*`,
  `unknown-group`, `mounts-*`, `invalid-claude-group`, ...) were confirmed as
  test output: tests ran `initGroupFilesystem` against the real tree. The
  vitest config now points `NANOCLAW_HOST_SHIMS_DIR` / `NANOCLAW_MCP_SHIMS_DIR`
  at a temp dir, and the litter was removed on 2026-09-26. The group dirs
  `readpendingbatch`, `tailpersist` and `vaulttranscript` under `groups/` are
  still untriaged.
- (Resolved 2026-11-03.) `add-host-scripts` now installs the shim pool and registry; the memory
  pipeline is installed by `add-memory-stack`.
- Git worktrees of the instance repo must live outside it: its automatic
  "chore" commits record an in-repo worktree as an embedded-repo entry.

