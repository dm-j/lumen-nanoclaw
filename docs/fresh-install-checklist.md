# Lumen move / rebuild checklist

What *you* do around [`scripts/lumen-backup.sh`](../scripts/lumen-backup.sh) and
[`scripts/lumen-restore.sh`](../scripts/lumen-restore.sh) (map: [fresh-install.md](fresh-install.md)).
Works for a wipe-and-reinstall or a move to a new machine. Tick as you go.

## A. Before the day (once, can be done any time)

**Remote repos** — the backup should be your safety net, not the only copy.
- [ ] Create a **private** GitHub repo for `PrefixRouter`, add it as `origin`, push. Check `git status` first; don't commit generated plists (the live one embeds an OneCLI agent token).
- [ ] Create a **private** repo for the vault (`~/Projects/obsidian/lumen-data`: it holds personal notes, transcripts and digests). Add `origin`, push, then change `nightly-commit.sh` to `git push` after committing (its own comment says to do this). Decide first whether `.obsidian/` workspace state and the `.memsearch` dirs belong in git.
- [ ] Push `lumen-nanoclaw` (trunk) and `lumen-nanoclaw-instance` (`dm-j/lumen-instance`): `git log @{u}..` should be empty in both. The instance repo is ~950 MB of `groups/`; check for stray large files or session data before pushing.
- [ ] Confirm the GitHub ssh key works from a clean shell (`ssh -T git@github.com`) and that you know where its passphrase lives.

**Accounts and logins** — none of these travel in a backup; you re-authenticate each one.
- [ ] Claude Code / Anthropic login
- [ ] GitHub (ssh key is in the backup; `gh` login is separate if you use it)
- [ ] Ollama account (`ollama signin`, needed for the `:cloud` models)
- [ ] Provider keys behind OneCLI (Fireworks, Ollama Cloud, others in the vault). They restore with the vault, but know where the originals are in case a restore fails
- [ ] Telegram bot token (in `.env`; the source of truth is @BotFather)
- [ ] NanoClaw account, only if you want the hardened image instead of a local build
- [ ] Tailscale, Parsec, Docker Desktop, Obsidian (app) sign-ins
- [ ] Calendar ICS URL (`CALENDAR_PERSONAL_ICS_URL` in `.env`)

**Tidy the live machine** (optional, but it shrinks what you have to reason about)
- [ ] Unload/delete stale launchd jobs: `com.nanoclaw-v2-1328e183`, `com.nanoclaw.statusbar`, `com.lmstudio.autostart`
- [ ] Decide which `~/.local/bin` tools Lumen really needs (`rtk`, `memsearch`, `fireconnect`, ...) and note where each installs from
- [ ] Clear finished worktrees: `~/.claude/hooks/worktree-registry.sh sync`, then `list` vs `git worktree list`

## B. Cutover day

1. [ ] Tell anyone who messages Lumen that she'll be down.
2. [ ] Stop the host so DBs are quiet: `launchctl bootout gui/$(id -u)/com.nanoclaw-v2-83def653`. Leave OneCLI (Docker) running: the backup dumps it live.
3. [ ] `scripts/lumen-backup.sh` → check the printed git state (no `dirty`, no `unpushed` on repos you care about, or you accept the backup as their copy).
4. [ ] Spot-check: `tar tzf <dir>/vault.tgz | head`, `tar tzf <dir>/instance.tgz | head`, `wc -c <dir>/onecli.sql` (non-trivial size), `sqlite3 <dir>/data/v2.db 'select count(*) from agent_groups'`.
5. [ ] Copy the backup dir **off the machine** to encrypted or offline storage. Confirm the copy opens.
6. [ ] **New machine only:** keep the old one powered off or with the host stopped. Two hosts must never poll the same Telegram bot token, and two OneCLI vaults will drift.
7. [ ] Wipe / switch machines. Create macOS user `lumen` (same name, so `/Users/lumen/...` paths hold).
8. [ ] `scp` or copy `lumen-restore.sh` plus the backup dir over; run `bash lumen-restore.sh <backup-dir>`. Do step 0 (Tailscale, Parsec, ssh, auto-login, no-sleep) first, then continue remotely if you like.
9. [ ] Work through the manual checklist the script prints at the end.

## C. Verification (don't skip: this is the only test of the restore)

- [ ] `curl -s http://localhost:8787/status` shows PrefixRouter up; `curl http://127.0.0.1:10254/v1/health` returns 200
- [ ] `onecli agents list` shows the agents; secrets are present in the web UI (`http://127.0.0.1:10254`) and agents are in `all` secret mode
- [ ] `launchctl list | grep -E 'nanoclaw|prefixrouter|onecli|inbox-watch'` shows all four
- [ ] `ncl groups list` shows every agent group; check `logs/nanoclaw.error.log` is quiet
- [ ] Send Lumen a Telegram message and get a real reply (this exercises PrefixRouter, OneCLI, the container and the model in one go)
- [ ] Obsidian opens the vault with plugins enabled; wait for the next cron run (or run `Meta/scripts/inbox-watch.sh`) and check `Meta/scripts/logs/`
- [ ] Only now delete the old install / old backup copies you no longer need

## D. Recurring things to expect on any new machine

- **Same paths or regenerate.** If the username or project paths change, the launchd plists, `~/.config/nanoclaw/mount-allowlist.json`, the vault's plist/cron entries and the install slug (`com.nanoclaw-v2-<sha1(path)[:8]>`) all need regenerating. Run `pnpm exec tsx setup/index.ts --step service` for the host and edit the rest by hand.
- **Timezone.** `TZ` in `.env` plus each group's override; check `date` on the new box.
- **Docker Desktop settings:** resources and file sharing for `~/Projects`, "start at login". Re-pull or rebuild the agent image.
- **Sleep and login:** auto-login on, sleep off, or launchd jobs silently don't run.
- **Permissions prompts:** Full Disk Access, Screen Recording and Accessibility for Parsec and Terminal/ssh; `osascript` Obsidian restarts need Automation permission.
- **Node linkage:** plists hardcode `/opt/homebrew/bin/node`; `brew link --force node@22`.
- **Fresh OneCLI CA and agent tokens.** A restore brings them back; a from-scratch OneCLI install does not, and the PrefixRouter plist's embedded proxy token would then be invalid. Regenerate it from `onecli agents list`.
- **Tailnet identity:** remove the old node in the Tailscale admin console; update phone/tablet ssh hosts if the name changed.
- **`sqlite3` and `jq`** must be on the host `PATH`; several host-shims call them under a minimal `PATH`.
- **After it works:** update `docs/local-patch-notes.md` (see the `/local-patch-notes` skill) and record what surprised you in [roadmap/fresh-install-gaps.md](roadmap/fresh-install-gaps.md) so the next move is easier.
