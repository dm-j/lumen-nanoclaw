#!/usr/bin/env bash
# Snapshot everything Lumen needs that is NOT recoverable from GitHub. Run BEFORE wiping the machine.
# Usage: scripts/lumen-backup.sh [out-dir]     (default ~/lumen-backup-YYYYMMDD)
# The output holds secrets (OneCLI vault, ssh key, bot token): copy it to encrypted/offline storage.
# Companion: scripts/lumen-restore.sh. Overview: docs/fresh-install.md.
set -uo pipefail

OUT="${1:-$HOME/lumen-backup-$(date +%Y%m%d)}"
P="$HOME/Projects"
TRUNK="$P/lumen-nanoclaw"
umask 077
mkdir -p "$OUT"
say() { printf '\n== %s\n' "$*"; }
tarx() { local name=$1; shift; tar -czf "$OUT/$name.tgz" "$@" 2>&1 | grep -v 'socket ignored' || true; echo "  $name.tgz $(du -h "$OUT/$name.tgz" | cut -f1)"; }

say "git state (anything with dirty files, unpushed commits, or no remote only survives via this backup)"
for r in "$TRUNK" "$P/lumen-nanoclaw-instance" "$P/PrefixRouter" "$P/obsidian/lumen-data"; do
  [ -d "$r/.git" ] || { echo "  $r: not a git repo"; continue; }
  remote=$(git -C "$r" remote | head -1)
  dirty=$(git -C "$r" status --short | wc -l | tr -d ' ')
  ahead=$([ -n "$remote" ] && git -C "$r" log --oneline '@{u}..' 2>/dev/null | wc -l | tr -d ' ' || echo n/a)
  echo "  $(basename "$r"): remote=${remote:-NONE} dirty=$dirty unpushed=$ahead"
done | tee "$OUT/git-state.txt"

say "trunk repo -> git bundle (all branches, incl. unpushed) + .env + data/"
git -C "$TRUNK" bundle create "$OUT/trunk.bundle" --all 2>&1 | tail -1
cp "$TRUNK/.env" "$OUT/trunk.env"
mkdir -p "$OUT/data"
sqlite3 "$TRUNK/data/v2.db" ".backup '$OUT/data/v2.db'" # consistent even with host running
# session DBs are copied live; stop the host first (launchctl bootout) if you want them quiesced
tar -C "$TRUNK" -czf "$OUT/data.tgz" --exclude='*.sock' --exclude='v2.db*' data 2>&1 | grep -v 'socket ignored' || true

say "instance repo (groups, host-shims, mcp-shims), PrefixRouter, Obsidian vault (with .git + .obsidian)"
tarx instance -C "$P" lumen-nanoclaw-instance
tarx prefixrouter -C "$P" --exclude=node_modules --exclude=logs --exclude=prefixrouter.log PrefixRouter
tarx vault -C "$P" obsidian/lumen-data

say "OneCLI vault (postgres dump + app-data volume + ~/.onecli)"
if docker compose -f "$HOME/.onecli/docker-compose.yml" exec -T postgres pg_dump -U onecli --clean --if-exists onecli > "$OUT/onecli.sql"; then
  echo "  onecli.sql $(du -h "$OUT/onecli.sql" | cut -f1)"
else echo "  !! pg_dump failed: is the OneCLI stack up? secrets are NOT backed up"; fi
docker run --rm -v onecli_app-data:/d -v "$OUT":/o alpine tar czf /o/onecli-app-data.tgz -C /d . && echo "  onecli-app-data.tgz"
tarx onecli-dir -C "$HOME" .onecli

say "home config (ssh, claude, nanoclaw allowlist, launchd, crontab, obsidian app)"
tarx ssh -C "$HOME" .ssh
tarx nanoclaw-config -C "$HOME" .config/nanoclaw
(cd "$HOME/.claude" && tarx_files=$(ls -d CLAUDE.md settings.json hooks skills agents worktrees.json statusline-command.sh keybindings.json projects/*/memory 2>/dev/null) \
  && tar -czf "$OUT/claude-home.tgz" $tarx_files && echo "  claude-home.tgz")
mkdir -p "$OUT/launchagents"
# live services only: skip 1328e183 + statusbar (point at the old ~/Projects/nanoclaw) and lmstudio (experiment ended)
for l in com.nanoclaw-v2-83def653 com.prefixrouter.server com.onecli.gateway com.lumen-vault.inbox-watch; do
  cp "$HOME/Library/LaunchAgents/$l.plist" "$OUT/launchagents/" 2>/dev/null || echo "  !! missing $l.plist"
done
crontab -l > "$OUT/crontab.txt" 2>/dev/null || echo "  (no crontab)"
cp "$HOME/Library/Application Support/obsidian/obsidian.json" "$OUT/obsidian-app.json" 2>/dev/null || true

say "inventories (for reference; the restore script has its own install list)"
{ echo "# brew leaves"; brew leaves; echo "# casks"; brew list --cask; echo "# ollama"; ollama list
  echo "# ~/.local/bin"; ls -l "$HOME/.local/bin"; echo "# npm -g"; npm ls -g --depth 0
  echo "# pipx"; pipx list --short; echo "# uv tools"; uv tool list
  echo "# tailscale"; tailscale status 2>&1 | head -5; } > "$OUT/inventory.txt" 2>&1

chmod -R go-rwx "$OUT"
say "done: $OUT ($(du -sh "$OUT" | cut -f1)). Copy it OFF this machine, then spot-check: tar tzf $OUT/vault.tgz | head"
