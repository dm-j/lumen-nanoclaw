---
name: add-lumen-customizations
description: Use when re-applying this fork's Lumen customizations onto a fresh or newly updated NanoClaw (after /update-nanoclaw or /migrate-nanoclaw, on a new machine, or when asked to "rebuild Lumen"). Applies the instance-repo split, the host-shim layer, host cron and the memory stack in order, with a test checkpoint after each.
---

# Add Lumen Customizations

One entry point for rebuilding everything about this fork that has an installer skill. It does not
contain code of its own: it runs the fork's skills in the only order that works, checks after each, and
tells you what is *not* covered so nothing is forgotten.

| # | Skill | What it brings | Source |
|---|---|---|---|
| 1 | `add-instance-repo` | private instance repo, symlinks, commit hooks | `install.sh` |
| 2 | `add-host-scripts` | host-shim layer: pool + registry, mcp-shims manifest, templates | branch `host-shim` |
| 3 | `add-host-cron` | schedule host-shim scripts on a cron | branch `host-cron` |
| 4 | `add-memory-stack` | projected sessions, vault transcript export, attachment captioning, remember/recall, wake script | branch `memory-stack` |

Order matters: (1) first, so the shim trees and `groups/` are already symlinks into the private repo
when (2) starts writing into them; (3) needs (2); (4) needs (2), and (3) only for scheduled digests.

**Validated:** applied literally on a clean checkout of upstream `639577c3` (the fork's merge-base,
2026-08-11): host typecheck clean, 1406 host tests, 184 container tests, at every checkpoint. On a newer
upstream expect conflicts (see below); the procedure is the same.

## Before you start

1. A working upstream NanoClaw install: the base `/setup` flow done, `pnpm install --frozen-lockfile`
   run, Node 22, `bun` and Docker available.
2. The fork must be reachable as a git remote. The skills fetch their branches from `origin`; if your
   `origin` is upstream, set `FORK_REMOTE=<remote name of dm-j/lumen-nanoclaw>` for every command below
   (and `git remote add`/`fetch` it first).
3. A clean working tree (the driver commits one layer per skill).
4. Bring the skill folders in from the fork (they are not part of upstream):

```bash
git fetch "${FORK_REMOTE:-origin}" main
git checkout "${FORK_REMOTE:-origin}/main" -- \
  .claude/skills/add-lumen-customizations .claude/skills/add-instance-repo \
  .claude/skills/add-host-scripts .claude/skills/add-host-cron .claude/skills/add-memory-stack \
  .claude/skills/add-projected-sessions .claude/skills/add-vault-memory-pipeline .claude/skills/recipe
git reset -q .claude/skills        # leave them untracked/unstaged until you commit them on purpose
```

5. Restoring on a new machine? Clone your private instance repo to `~/Projects/lumen-nanoclaw-instance`
   first (or set `NANOCLAW_INSTANCE_REPO`), so step 1 links it instead of creating an empty one.

## Apply

```bash
sh .claude/skills/add-lumen-customizations/apply.sh
```

- `--only <skill>` runs a single step; `--skip-instance` skips step 1; `--no-checks` skips the
  typecheck/test checkpoints (do not, except to get past a known-bad step).
- Each skill is committed as its own layer (`Apply <skill> (add-lumen-customizations)`), hooks bypassed,
  so a conflict in one never contaminates another and you can `git revert` a layer.
- It skips a skill whose "already applied" check passes, so it is safe to re-run after fixing a conflict.

**If it stops on a conflict:** `git apply --3way` has left markers in the named files. Resolve them by
intent using the table in that skill's `SKILL.md` (step 2), `git add` them, and re-run the driver.
Migration numbers are ordering hints only (identity is the migration `name`): when upstream already uses
a number, alias the import (`migration021 as migration021ApprovalQuestion`) and never rename an applied
migration. The one dependency added is `sharp` (`pnpm add 'sharp@^0.35.3'`); the repo's supply-chain
rules (`minimumReleaseAge`, no new `onlyBuiltDependencies`) apply.

## After applying

```bash
./container/build.sh                                   # rebuild the agent image
# per group, opt in to what you want (all off by default):
ncl projected-sessions enable --id <group-id>          # briefing + literal tail instead of transcript resume
ncl vault-transcripts enable --id <group-id>           # live vault transcript export
ncl groups config update --id <group-id> --wake-script "$(cat .claude/skills/add-memory-stack/wake-script.notes.example.sh)"
ncl groups restart --id <group-id>
# restart the host service so it runs the new code (pnpm run build first if it runs dist/):
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-<slug>
```

Group wiring that lives in the **instance repo**, not here: `host-shims/_registry.json` and
`mcp-shims/_registry.json` (which group gets which shim, with per-group `VAULT_PATH` etc.), the shim
scripts under `_pool/`, personas under `groups/`. They come back with the instance repo. Scheduling the
digests: `add-vault-memory-pipeline`; tuning briefings: `add-projected-sessions`.

## What no skill covers yet

These are real local changes with no installer. Each is listed, with the commit to start from, in
`docs/local-modifications.md`; apply them *after* the table above, from the fork:
`git cherry-pick <hash>` (expect hunks to need hand-merging against the memory-stack's edits).

| Feature | Start from |
|---|---|
| Message `subject` + unknown-destination fallback | `fc70677c` |
| Telegram ordered/backed-off delivery retry | `67262a80` |
| Telegram polling diagnostics (adapter logging) | `b6650ea3` |
| Approval expiry after TTL | `411c560e` |
| Agent-to-agent loop guards (wake once, then latch) | `485b830f`, `3de64708` |
| Shared day-token resolver (`src/day-resolve.ts`) | `bef29af5` |
| ISO-8601 UTC log timestamps; SQLite error tagging | `c0549a20`; `42bf0cfc` |
| Last-context Stop-hook dump | `de0c385d` |
| Follow-up timer (`set_followup`) | `9a49b612`, `dfad0f0f` |
| Stateless scheduled tasks | `4968cc11` |
| Agent-group description + routing table; `assign_task`; `decision_description` | `fdd3ff86`; `3592c47f`; `b744ab37` |
| Visual subagent (Vision group, multi-file `send_file`/`assign_task`) | `eb4bcf23` |
| Ops scripts: netwatch, log rotation, backups | `de91df72`, `55f4a440`, `42ea4db5` |
| Session sync transport (shelved, not live anywhere) | `5ee300e2` and the `feat/session-sync-*` branches |

The fork's Telegram adapter files (`src/channels/telegram*.ts`) come from `add-telegram`; the
fork's local additions to them are in the diagnostics commit above.

## Keeping this current

`add-memory-stack`, `add-host-scripts` and `add-host-cron` are snapshots: after changing any file they
own, refresh the branch from `main` and regenerate `files.txt` / `shared-files.patch` from a clean base
(procedure in `docs/local-modifications.md`, "Regenerating the bundle"), then re-run this driver on a
fresh worktree. A skill is only up to date if that run is green.

## Removal

Reverse in the opposite order using each skill's `REMOVE.md`: memory stack, host cron, host scripts, then
instance repo. Or `git revert` the layer commits the driver made.
