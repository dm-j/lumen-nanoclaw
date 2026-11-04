---
name: add-instance-repo
description: Use when the user wants personal/private per-install areas (agent groups, host and MCP shim scripts) kept in a separate private git repo and symlinked into the NanoClaw checkout, or when rebuilding that layout on a new machine or in a new worktree.
---

# Add Instance Repo

Splits a NanoClaw install in two:

- **the checkout** (this repo / your fork): generic code, skills, docs. Nothing personal.
- **the instance repo** (a separate, private git repo): everything specific to this install, i.e.
  `groups/` (agent personas and workspaces), `host-shims/` and `mcp-shims/` (scripts that routinely
  hardcode home addresses, vault paths, account names).

In the checkout, `groups/`, `mcp-shims/` and `host-shims/` become **gitignored symlinks** into the
instance repo, so upstream-shaped history never contains private data and an update never merges
against it. Runtime code needs no changes: Docker resolves symlinks before bind-mounting, and the
host-shim symlink-escape check resolves both sides with `realpathSync`.

## What gets installed

`install.sh` (idempotent) lays down, and `docs/instance-repo-split.md` describes:

| Piece | Where | Purpose |
|---|---|---|
| Instance repo skeleton | `$NANOCLAW_INSTANCE_REPO` (default `~/Projects/lumen-nanoclaw-instance`) | `groups/`, `host-shims/_pool/`, `mcp-shims/_pool/`, README; skipped if the repo already exists |
| Symlinks | `groups`, `host-shims`, `mcp-shims` in the checkout | point at the instance repo |
| `.gitignore` lines | `groups/*`, `/mcp-shims/`, `/host-shims/` | keep the private areas out of the checkout's git |
| `.husky/pre-commit` block | between `# >>> instance-repo` / `# <<< instance-repo` | `git add -A` in the instance repo whenever you commit in the checkout |
| `.husky/post-commit` | | if the instance repo has staged changes, a **backgrounded `claude -p`** commits them there as one commit with a real summary message (allowed tools: git add/commit/status/diff; **never pushes**) |
| `.husky/post-checkout` | | in a **git worktree** only: re-create the three symlinks, register the worktree (best-effort, `~/.claude/hooks/worktree-registry.sh`), `pnpm install --frozen-lockfile` under the pinned Node |
| `.husky/_/h`, `.husky/_/post-checkout` | tracked with `git add -f` | husky's dispatcher stubs; a fresh worktree has no `node_modules`, so without them tracked the hooks above never fire there |
| Instance repo `post-commit` | `<instance>/.git/hooks/post-commit` | copies `data/*.db` to `~/nanoclaw-db-backups/<UTC timestamp>/` on every commit to the instance repo |

The instance path is the `NANOCLAW_INSTANCE_REPO` environment variable, with the install-time choice
baked in as the hooks' default, so nothing is hardcoded to one username.

## Apply

Run this **first** among the fork's skills, before anything writes into `groups/`, `host-shims/` or
`mcp-shims/` (`add-host-scripts` puts the shim pool and registry in them).

```bash
# a fresh install
sh .claude/skills/add-instance-repo/install.sh

# rebuilding on a new machine: clone your private instance repo first, then link it in
git clone <your-private-instance-remote> ~/Projects/lumen-nanoclaw-instance
sh .claude/skills/add-instance-repo/install.sh

# the checkout already has real groups/ or shim directories with content you want to keep
sh .claude/skills/add-instance-repo/install.sh --migrate     # moves entries into the instance repo; never overwrites

# a different location
NANOCLAW_INSTANCE_REPO=/path/to/instance sh .claude/skills/add-instance-repo/install.sh
```

`install.sh` refuses (and says why) rather than guessing when: a symlink already points elsewhere, a
real non-empty directory is in the way without `--migrate`, or a husky hook exists with unrelated
content (merge `assets/<hook>` into it by hand). Re-running it is always safe.

Then add a private remote to the instance repo and push it deliberately; the hooks never do:

```bash
git -C ~/Projects/lumen-nanoclaw-instance remote add origin <private-remote>
git -C ~/Projects/lumen-nanoclaw-instance push -u origin HEAD
```

## Verify

```bash
ls -l groups host-shims mcp-shims                       # symlinks into the instance repo
git check-ignore -v groups/x mcp-shims host-shims       # all three ignored
git commit --allow-empty -m "hook test" && sleep 5 && git -C "$NANOCLAW_INSTANCE_REPO" log --oneline -3
ls ~/nanoclaw-db-backups | tail -2                      # a snapshot per instance-repo commit
```

(The empty commit only produces an instance commit if the instance repo has changes to stage.)

## Gotchas

- **Instance commits are automatic and local.** They use the `claude` CLI, so it must be on `PATH` in
  the environment git runs hooks from. The instance repo's branch can run far ahead of its remote.
- **Worktrees of the instance repo must live outside it.** Its automatic commits would record an
  in-repo worktree as an embedded-repo entry.
- **Tests must not write into the real trees.** The shim pool code in `add-host-scripts` honours
  `NANOCLAW_HOST_SHIMS_DIR` / `NANOCLAW_MCP_SHIMS_DIR`, and its vitest config points both at a temp dir.
- **Not part of this skill:** this fork's `pre-commit` also strips zero-width characters and rewrites
  the em dash to a hyphen in staged text files. That is separate commit hygiene (see
  `docs/instance-repo-split.md`); the installer leaves the rest of your `pre-commit` untouched.
- **DB backups are plain copies**, no rotation. `data/*.db` is not in either repo.

## Removal

See [REMOVE.md](REMOVE.md).
