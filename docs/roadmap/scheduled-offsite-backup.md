# Scheduled, off-machine, encrypted backup

Discussed 2026-10-13, written up 2026-10-20. **Built and tested, not switched on.** The script exists; nothing runs it, and nowhere is chosen for it to write to.

## Why this matters

Several things Lumen depends on exist **only on this Mac mini**, and nothing copies them anywhere automatically:

- `~/Projects/PrefixRouter` has no git remote (config, `usage.db`, request history).
- The Obsidian vault (`~/Projects/obsidian/lumen-data`) has no remote and had 305 uncommitted files on 2026-10-13. It is Lumen's memory.
- The instance repo (`lumen-nanoclaw-instance`: groups, agent memory, shims) has a remote but had **32 unpushed commits** on 2026-10-13. Its commits are made locally by the husky hook and never pushed.
- `data/v2.db` (users, wiring, tasks, approvals) and `.env`, the OneCLI vault and the SSH key.

`scripts/lumen-backup.sh` is a thorough manual pre-wipe snapshot, but it is manual. Time Machine has no usable destination (`tmutil latestbackup` fails with "Failed to mount destination"). The newest DB copy under `~/Backups` was from 2026-10-03.

Power is the reason to care now: the Mac is on a small UPS that only rides out ~5 minutes, `pmset autorestart` is on, and an extended outage ends in a **hard power cut**. `v2.db` is in WAL mode (survives that), but the per-session DBs use `journal_mode=DELETE` and are the weak spot. See also [Fresh-install gaps](fresh-install-gaps.md), which records the same missing remotes from the restore side.

## What exists

`scripts/lumen-nightly-backup.sh` (slim sibling of `lumen-backup.sh`):

- Consistent `v2.db` via `sqlite3 .backup` while the host runs, `.env`, SSH key, OneCLI config + `pg_dump`, instance repo, PrefixRouter (with its `.git`), vault (with its `.git`), `data/`.
- Skips reinstallable bulk: `groups/*/.tools`, `groups/*/tools`, `groups/*/.venv`, vault `.claude/worktrees`, `node_modules`, `logs`. This took a run from 385 MB to **177 MB** (vault 139 MB, `data/` 22 MB, OneCLI dump 10 MB, instance 6 MB).
- AES-256 (`openssl enc -pbkdf2 -iter 200000`) with a passphrase file; decrypts and lists the archive **before** pruning older copies.
- If the destination's parent directory is missing (drive unmounted, Dropbox not installed) it logs `SKIP` and exits 1 rather than creating the folder on the internal disk.
- Tested 2026-10-13: restored a test archive; `v2.db` passed `integrity_check` and held all 6 agent groups.
- Deliberately **not** included: git history of the instance repo (356 MB; push it instead).

## Decided

- **Destination: Dropbox** (David has it; no spare SSD, prices are high). Encrypt before it reaches the synced folder; Dropbox must never see plaintext (the set contains the bot token, OneCLI vault and SSH key).
- A USB thumb/old drive is a fine *additional* target, not the only one; a second off-machine copy is the point.
- Keep roughly **7 copies** (~1.2 GB) on a free 2 GB plan, or move the vault to a weekly run if more history is wanted.
- Schedule at about **08:20Z**, ahead of the router reboot window (see [network reliability](network-reliability.md)).

## Open / next steps (and why each)

1. **Install Dropbox on the Mac mini and sign in.** Needs the GUI. The script refuses to run until `~/Dropbox` exists. Alternative: a Dropbox app token + `rclone` (needs a Homebrew install, so ask first). *Why: the destination does not exist yet.*
2. **Create the passphrase** at `~/.config/lumen-backup/passphrase` (mode 600), generated without printing it, then **David reads it himself over SSH and stores it in a password manager**. *Why: a lost Mac with the only copy of the passphrase makes every backup undecryptable.*
3. **Add the launchd job** (no `KeepAlive`; a calendar interval) and run it once by hand to confirm a file lands in Dropbox and decrypts. *Why: until scheduled, none of this protects anything.*
4. **Push what has a remote**: this repo's unpushed commits, and the instance repo's (review what is in the 32 first — it holds group data and agent memory). *Why: cheapest durable copy for the code and history that the archive intentionally leaves out.*
5. **Give PrefixRouter and the vault a remote** (private), or accept the encrypted archive as their only off-machine copy. Tracked also in [Fresh-install gaps](fresh-install-gaps.md). *Why: no remote means git history is only as safe as this one disk.*
6. **Rehearse a real restore** onto a scratch location, not just `v2.db`. *Why: a backup nobody has restored is a guess.*
7. Optional hardening: consider moving the per-session DBs off `journal_mode=DELETE` or confirming they are disposable, given hard-power-cut exposure; see [Session-sync transport](../session-sync-transport.md).

## Not decided

- Retention beyond 7 nightly copies (weekly/monthly tier?).
- Whether the vault ships every night or weekly (it is 79% of each archive).
- Whether to add a second target (laptop over Tailscale is the free option).
