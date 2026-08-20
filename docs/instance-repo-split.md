# Instance repo split

`lumen-nanoclaw` (this repo) is the generic fork: skills, docs, `recipe`
ledger, host code. It carries no personal data by construction.

Everything specific to *this install* — personas, per-group config, and the
mcp-shims/host-shims scripts (which routinely hardcode things like a home
address or a local vault path) — lives in a separate private repo:

```
~/Projects/lumen-nanoclaw-instance/
  groups/
  mcp-shims/
  host-shims/
```

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

- `groups/`, `mcp-shims/`, `host-shims/` were moved wholesale on 2026-08-07,
  including several test-fixture-looking dirs (`bravo`, `newbie`,
  `surfy-*`, `unknown-group`, `mounts-*`, `invalid-claude-group`,
  `_ping-test`, `readpendingbatch`, `tailpersist`, `vaulttranscript`) that
  may just be disposable test output — not yet triaged.
- `add-mcp-shim` / `add-host-scripts` skill docs may still describe these
  directories as if they're tracked inside `lumen-nanoclaw` directly; worth
  a pass to point at the instance repo instead.

