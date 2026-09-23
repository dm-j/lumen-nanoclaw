# Rebuilding Lumen on a wiped machine

Two scripts do the work; this doc is the map. Written 2026-09-23 from an audit of the live Mac Mini.

```
scripts/lumen-backup.sh [out-dir]      # BEFORE the wipe. Snapshots everything not in GitHub.
scripts/lumen-restore.sh <backup-dir>  # AFTER the wipe. Interactive, step-by-step, re-runnable.
```

`lumen-restore.sh` is standalone (it needs nothing from the repo), so `scp` it over with the backup.
The backup holds secrets (OneCLI vault, ssh key, bot token): copy it to encrypted or offline storage.
**Not run end-to-end yet** — syntax-checked only. Dry-run the backup on the live machine first and
`tar tzf` the outputs; that costs nothing and proves the hard half.

## Why paths must stay identical

User `lumen`, repos under `~/Projects/`. The launchd plists, the mount allowlist, the vault's cron/plist
scripts and the install slug (`com.nanoclaw-v2-<sha1(project path)[:8]>` = `83def653`) all hardcode them.
Restoring to the same paths lets the saved plists be copied back verbatim instead of regenerated.

## What Lumen depends on

| Layer | What | Where it lives / how it returns |
|---|---|---|
| Remote access | Tailscale (ssh from phone/tablet), Parsec (GUI from desktop), Remote Login, auto-login, no-sleep | Step 0 of the restore. Do it first. LaunchAgents only run in a logged-in session, so a headless Mini needs auto-login. Delete the old tailnet node in the admin console before re-joining or the new one becomes `<name>-1`. `~/.ssh` (incl. `authorized_keys`) is in the backup |
| Toolchain | Homebrew, Node 22 (must be linked at `/opt/homebrew/bin/node`), pnpm 11, Bun, uv, Docker Desktop, Claude Code, `jq`, `ripgrep`, `sqlite3`, `socat`, `tmux`, `ffmpeg`, `python3`, `pipx` | Restore step 1 |
| Trunk | `~/Projects/lumen-nanoclaw` (`dm-j/lumen-nanoclaw`), `.env`, `data/` (`v2.db`, session DBs) | Git bundle (includes unpushed work) + `.env` + `data/` |
| Instance | `~/Projects/lumen-nanoclaw-instance` (`dm-j/lumen-instance`): `groups/` (~950 MB), `host-shims/`, `mcp-shims/`, symlinked into trunk | Tarball with `.git` |
| OneCLI | Gateway (Docker compose in `~/.onecli`, volumes `onecli_pgdata` + `onecli_app-data`), CLI binary pinned in `versions.json`, the vault secrets (Fireworks, Ollama Cloud, ...) | `pg_dump` + app-data volume tar + `~/.onecli`. Secrets exist nowhere else |
| PrefixRouter | `~/Projects/PrefixRouter` (`config.json` = routing rules and `role/*` aliases), port 8787 | Tarball. **Has no git remote.** Its launchd plist embeds a OneCLI agent token in `HTTPS_PROXY`, so restore the saved plist, don't regenerate |
| Models | Ollama (`nomic-embed-text` local; `:cloud` models need `ollama signin`) | Restore step 5 |
| Vault | Obsidian + `~/Projects/obsidian/lumen-data/lumen-data`, 13 community plugins (in `.obsidian/`), vault scripts, `.claude/agents/` (briefer, digester, librarian, seeker, sorter) | Tarball with `.git`. **Local git only, nightly commit, no push** |
| Scheduling | User crontab (5 vault jobs: nightly commit, sorter, linker, transcript assembly) and `com.lumen-vault.inbox-watch` | `crontab -l` dump + saved plist |
| Claude Code | `~/.claude` settings, hooks, skills, agents, `CLAUDE.md`, per-project memory; plugins ponytail/memsearch/typescript-lsp | Config tarball; plugins reinstall from marketplaces; login is manual |
| Container image | `nanoclaw-agent-v2-<slug>:latest` | Local build (`NANOCLAW_HARDENED_IMAGE=false ./container/build.sh`) or the hardened image via a NanoClaw account (`setup/index.ts --step registry`) |

Live launchd services after restore: `com.nanoclaw-v2-83def653`, `com.prefixrouter.server`, `com.onecli.gateway`,
`com.lumen-vault.inbox-watch`, plus `homebrew.mxcl.ollama` (via `brew services`).
**Deliberately not restored:** `com.nanoclaw-v2-1328e183` and `com.nanoclaw.statusbar` (both point at the old
`~/Projects/nanoclaw` checkout), `com.lmstudio.autostart` (experiment ended 2026-08-21), and the sibling
dirs `nanoclaw`, `nanoclaw-lumen` (previous installs).

## Things that need a human

Docker Desktop first launch; `claude` login; Tailscale and Parsec sign-in and permissions; Obsidian
"trust author" for the community plugins; `ollama signin`; Full Disk Access if cron/launchd jobs hit
permission errors. The restore script prints these as a checklist.

## Known gaps (also in [roadmap/fresh-install-gaps.md](roadmap/fresh-install-gaps.md))

- PrefixRouter and the vault have no remote, so this backup is currently their only off-machine copy.
- `rtk`, `memsearch` and the other `~/.local/bin` tools have no recorded install source; the backup lists them but the restore can't reinstall them.
- The restore is unverified end to end. The first real test is the wipe itself, so keep the old backup until Lumen answers a message.
