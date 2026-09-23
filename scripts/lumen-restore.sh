#!/usr/bin/env bash
# Rebuild Lumen on a freshly wiped Mac from a scripts/lumen-backup.sh snapshot.
# Usage: bash lumen-restore.sh /path/to/lumen-backup-YYYYMMDD     (can run before the repo exists: it's standalone)
# Semi-automated: each step asks y/N/q and is safe to re-run. Paths are deliberately identical to the
# old machine (user "lumen", ~/Projects/...): launchd plists, the mount allowlist and the install slug
# (com.nanoclaw-v2-83def653 = sha1 of the project path) all depend on it. Overview: docs/fresh-install.md.
set -uo pipefail

B="${1:?usage: $0 <backup-dir>}"
P="$HOME/Projects"
TRUNK="$P/lumen-nanoclaw"
[ "$(id -un)" = lumen ] || echo "!! not user 'lumen': absolute paths in plists/allowlist/vault scripts will be wrong"

step() { # step "title" fn
  printf '\n=== %s\n' "$1"; read -r -p "run? [y/N/q] " a
  case "$a" in y|Y) "$2" || echo "!! step failed (fix, then re-run this script and repeat the step)";; q|Q) exit 0;; esac
}

ensure_brew() {
  command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
}

s_remote() {
  ensure_brew
  brew install --cask tailscale-app parsec 2>&1 | tail -3 # cask name is tailscale-app on current brew; `brew search tailscale` if it errors
  cat <<'EOF'
  MANUAL (do these now so you can finish the rest over ssh/Parsec):
   - open Tailscale, sign in. In the admin console DELETE the old Mac Mini node first, or this one comes up as "<name>-1".
   - open Parsec, sign in (grant Screen Recording + Accessibility when prompted).
   - System Settings > General > Sharing > Remote Login: ON (ssh over the tailnet).
   - System Settings > Users & Groups > Automatic login: this user. LaunchAgents only run in a logged-in session.
   - sudo pmset -a sleep 0 displaysleep 0   (headless box: never sleep)
EOF
}

s_toolchain() {
  ensure_brew
  brew install git git-lfs jq ripgrep sqlite socat tmux ffmpeg python@3.12 pipx node@22 ollama
  brew link --force --overwrite node@22 # launchd plists hardcode /opt/homebrew/bin/node
  brew install --cask docker-desktop claude-code obsidian
  command -v pnpm >/dev/null || npm install -g pnpm
  command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
  command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
  mkdir -p "$HOME/.local/bin"
  echo "  MANUAL: launch Docker Desktop once and accept its prompts; run 'claude' once to log in."
  echo "  ALSO: ~/.local/bin had rtk, memsearch, ncl, prefixrouter etc. (see $B/inventory.txt). ncl/prefixrouter come back with the repos; reinstall rtk + memsearch by hand."
}

s_files() {
  mkdir -p "$P"
  tar -xzf "$B/ssh.tgz" -C "$HOME" && chmod 700 "$HOME/.ssh"
  tar -xzf "$B/nanoclaw-config.tgz" -C "$HOME"
  tar -xzf "$B/claude-home.tgz" -C "$HOME/.claude" 2>/dev/null || { mkdir -p "$HOME/.claude"; tar -xzf "$B/claude-home.tgz" -C "$HOME/.claude"; }
  tar -xzf "$B/instance.tgz" -C "$P"
  tar -xzf "$B/prefixrouter.tgz" -C "$P"
  tar -xzf "$B/vault.tgz" -C "$P"
  [ -d "$TRUNK/.git" ] || git clone "$B/trunk.bundle" "$TRUNK"
  git -C "$TRUNK" remote set-url origin git@github.com:dm-j/lumen-nanoclaw.git
  cp "$B/trunk.env" "$TRUNK/.env"
  tar -xzf "$B/data.tgz" -C "$TRUNK"
  cp "$B/data/v2.db" "$TRUNK/data/v2.db"
  for d in groups host-shims mcp-shims; do ln -sfn "$P/lumen-nanoclaw-instance/$d" "$TRUNK/$d"; done
  crontab "$B/crontab.txt"
  ~/.claude/hooks/worktree-registry.sh sync 2>/dev/null || true
}

s_onecli() {
  cd "$TRUNK" || return 1
  V=$(jq -r '."onecli-cli"' versions.json); G=$(jq -r '."onecli-gateway"' versions.json)
  OS=$(uname -s | tr '[:upper:]' '[:lower:]'); ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  curl -fsSL -o /tmp/onecli.tgz "https://github.com/onecli/onecli-cli/releases/download/v${V}/onecli_${V}_${OS}_${ARCH}.tar.gz" \
    && tar -xzf /tmp/onecli.tgz -C /tmp && install -m 0755 /tmp/onecli "$HOME/.local/bin/onecli"
  tar -xzf "$B/onecli-dir.tgz" -C "$HOME" # config.json, credentials, CA, compose file
  cd "$HOME/.onecli" || return 1
  export ONECLI_VERSION="$G"
  docker compose up -d postgres && sleep 15
  docker compose exec -T postgres psql -U onecli -d onecli < "$B/onecli.sql" >/dev/null
  docker volume create onecli_app-data >/dev/null
  docker run --rm -v onecli_app-data:/d -v "$B":/o alpine tar xzf /o/onecli-app-data.tgz -C /d
  docker compose pull onecli && docker compose up -d
  sleep 5; curl -s -o /dev/null -w 'onecli /v1/health -> %{http_code}\n' http://127.0.0.1:10254/v1/health
  onecli agents list | head -20
}

s_build() {
  cd "$TRUNK" || return 1
  pnpm install --frozen-lockfile && pnpm run build
  # local build avoids needing a NanoClaw registry account; use `pnpm exec tsx setup/index.ts --step registry` to fetch the hardened image instead
  NANOCLAW_HARDENED_IMAGE=false ./container/build.sh
  (cd "$P/PrefixRouter" && npm install --omit=dev 2>&1 | tail -2)
}

s_models() {
  brew services start ollama; sleep 3
  echo "  MANUAL: 'ollama signin' (needed for the :cloud models)."
  for m in nomic-embed-text gemma4:31b-cloud glm-5.3-flash:cloud deepseek-v4.1-flash:cloud deepseek-v4-flash:0731-cloud; do ollama pull "$m"; done
}

s_services() {
  mkdir -p "$HOME/Library/LaunchAgents"
  for f in "$B"/launchagents/*.plist; do
    cp "$f" "$HOME/Library/LaunchAgents/"
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$(basename "$f")" 2>&1 | grep -v 'already' || true
  done
  sleep 8
  curl -s http://localhost:8787/status | head -c 400; echo
  cd "$TRUNK" && pnpm exec tsx setup/index.ts --step verify
}

s_manual() {
  cat <<EOF
  MANUAL CHECKLIST
   [ ] Obsidian: open vault ~/Projects/obsidian/lumen-data/lumen-data, "Trust author" to enable the 13 community plugins (list in .obsidian/community-plugins.json)
   [ ] Claude Code: /login; plugins ponytail, memsearch, typescript-lsp reinstall from settings.json marketplaces (check /plugin)
   [ ] Full Disk Access for Terminal/ssh (System Settings > Privacy) if cron/launchd jobs hit permission errors
   [ ] Telegram: message the bot; it is 'strict' (David-only) per data/v2.db
   [ ] gh/GitHub ssh: ssh -T git@github.com (key came from ~/.ssh)
   [ ] First-turn test: send Lumen a message; check logs/nanoclaw.error.log; ncl groups list
   [ ] Delete the backup dir from unencrypted storage once verified
EOF
}

step "0. Remote access first (Tailscale, Parsec, ssh, auto-login, no-sleep)" s_remote
step "1. Toolchain (brew, node 22, pnpm, bun, uv, Docker Desktop, Claude Code, Obsidian)" s_toolchain
step "2. Restore files (ssh, repos, data, vault, PrefixRouter, crontab)" s_files
step "3. OneCLI (CLI + gateway + vault restore)" s_onecli
step "4. Build (pnpm, container image, PrefixRouter deps)" s_build
step "5. Ollama models" s_models
step "6. launchd services + verify" s_services
step "7. Manual checklist" s_manual
