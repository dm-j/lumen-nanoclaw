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

No remote is configured yet for `lumen-nanoclaw-instance` — it's a local git
repo until a private GitHub repo is created and wired as `origin`.

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
- `add-host-scripts` and `add-vault-memory-pipeline` are install-recipe skills
  that describe the per-group seeding; they do not mention the registry.
- Git worktrees of the instance repo must live outside it: its automatic
  "chore" commits record an in-repo worktree as an embedded-repo entry.

