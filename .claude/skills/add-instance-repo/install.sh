#!/bin/sh
# add-instance-repo installer. Idempotent: safe to re-run; changes nothing that is already in place.
#
#   sh .claude/skills/add-instance-repo/install.sh [--migrate] [--no-instance-init]
#
# Environment:
#   NANOCLAW_INSTANCE_REPO   where the private instance repo lives (default: ~/Projects/lumen-nanoclaw-instance)
#
# Run from anywhere inside the NanoClaw checkout (a worktree works too).
set -eu

MIGRATE=0
INIT=1
for a in "$@"; do
  case "$a" in
    --migrate) MIGRATE=1 ;;
    --no-instance-init) INIT=0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel)
SKILL="$ROOT/.claude/skills/add-instance-repo"
ASSETS="$SKILL/assets"
INSTANCE="${NANOCLAW_INSTANCE_REPO:-$HOME/Projects/lumen-nanoclaw-instance}"
changed=0
say() { printf '%s\n' "$*"; }
did() { changed=1; say "  + $*"; }

[ -d "$ASSETS" ] || { echo "assets not found at $ASSETS" >&2; exit 1; }
say "NanoClaw checkout : $ROOT"
say "Instance repo     : $INSTANCE"

# ---- 1. the instance repo itself ------------------------------------------------------------------
if [ ! -d "$INSTANCE/.git" ]; then
  if [ "$INIT" = 1 ]; then
    mkdir -p "$INSTANCE/groups" "$INSTANCE/host-shims/_pool" "$INSTANCE/mcp-shims/_pool"
    git -C "$INSTANCE" init -q
    cp "$ASSETS/instance-README.md" "$INSTANCE/README.md"
    touch "$INSTANCE/groups/.gitkeep" "$INSTANCE/host-shims/_pool/.gitkeep" "$INSTANCE/mcp-shims/_pool/.gitkeep"
    git -C "$INSTANCE" add -A
    git -C "$INSTANCE" -c user.name="${GIT_AUTHOR_NAME:-nanoclaw}" -c user.email="${GIT_AUTHOR_EMAIL:-nanoclaw@localhost}" \
      commit -q -m "Initialise instance repo"
    did "created instance repo skeleton"
  else
    echo "instance repo missing at $INSTANCE (clone yours there, or drop --no-instance-init)" >&2
    exit 1
  fi
fi
for name in groups host-shims mcp-shims; do
  [ -d "$INSTANCE/$name" ] || { mkdir -p "$INSTANCE/$name"; did "created $INSTANCE/$name"; }
done

# ---- 2. the symlinks in the checkout ----------------------------------------------------------------
for name in groups host-shims mcp-shims; do
  link="$ROOT/$name"
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$INSTANCE/$name" ] || { echo "$link points at $(readlink "$link"), not $INSTANCE/$name; fix by hand" >&2; exit 1; }
  elif [ -e "$link" ]; then
    if [ -z "$(ls -A "$link" 2>/dev/null)" ]; then
      rmdir "$link"; ln -s "$INSTANCE/$name" "$link"; did "linked $name (was an empty dir)"
    elif [ "$MIGRATE" = 1 ]; then
      # Move entries into the instance repo; refuse to overwrite anything already there.
      for e in "$link"/* "$link"/.[!.]*; do
        [ -e "$e" ] || continue
        b=$(basename "$e")
        [ -e "$INSTANCE/$name/$b" ] && { echo "refusing to overwrite $INSTANCE/$name/$b" >&2; exit 1; }
        mv "$e" "$INSTANCE/$name/$b"
      done
      rmdir "$link"; ln -s "$INSTANCE/$name" "$link"; did "migrated $name into the instance repo and linked it"
    else
      echo "$link is a non-empty real directory; re-run with --migrate to move its contents into the instance repo" >&2
      exit 1
    fi
  else
    ln -s "$INSTANCE/$name" "$link"; did "linked $name"
  fi
done

# ---- 3. .gitignore ----------------------------------------------------------------------------------
GI="$ROOT/.gitignore"
touch "$GI"
for line in 'groups/*' '/mcp-shims/' '/host-shims/'; do
  if ! grep -qxF "$line" "$GI"; then
    if ! grep -q 'add-instance-repo' "$GI"; then
      printf '\n# Private per-install areas live in the instance repo and are symlinked in (add-instance-repo).\n' >> "$GI"
    fi
    printf '%s\n' "$line" >> "$GI"; did ".gitignore: $line"
  fi
done

# ---- 4. husky hooks ---------------------------------------------------------------------------------
H="$ROOT/.husky"
mkdir -p "$H/_"
sub() { sed "s#@INSTANCE_DEFAULT@#$INSTANCE#g" "$1"; }

block=$(sub "$ASSETS/pre-commit.block")
if [ ! -f "$H/pre-commit" ]; then
  printf '%s\n' "$block" > "$H/pre-commit"; did ".husky/pre-commit (new)"
elif ! grep -q '>>> instance-repo' "$H/pre-commit"; then
  printf '\n%s\n' "$block" >> "$H/pre-commit"; did ".husky/pre-commit: instance block appended"
fi

for hook in post-commit post-checkout; do
  if [ ! -f "$H/$hook" ]; then
    sub "$ASSETS/$hook" > "$H/$hook"; did ".husky/$hook"
  elif ! grep -q 'NANOCLAW_INSTANCE_REPO' "$H/$hook"; then
    echo ".husky/$hook already exists with other content; merge $ASSETS/$hook into it by hand" >&2; exit 1
  fi
done

# Husky regenerates .husky/_/ on `pnpm install`, but a fresh git worktree has no node_modules yet, so the
# dispatcher stubs for post-checkout must be tracked or the worktree bootstrap hook never fires.
for f in h post-checkout; do
  if [ ! -f "$H/_/$f" ] || ! cmp -s "$ASSETS/husky-_/$f" "$H/_/$f"; then
    cp "$ASSETS/husky-_/$f" "$H/_/$f"; chmod +x "$H/_/$f"; did ".husky/_/$f"
  fi
  git -C "$ROOT" add -f "$H/_/$f" 2>/dev/null || true
done

# ---- 5. the instance repo's own DB-snapshot hook -----------------------------------------------------
HOOK="$INSTANCE/.git/hooks/post-commit"
want=$(sed "s#@NANOCLAW_ROOT@#$ROOT#g" "$ASSETS/instance-post-commit")
if [ ! -f "$HOOK" ] || [ "$(cat "$HOOK")" != "$want" ]; then
  if [ -f "$HOOK" ] && ! grep -q 'nanoclaw-db-backups' "$HOOK"; then
    echo "$HOOK exists with other content; leaving it. Add the DB snapshot by hand if you want it." >&2
  else
    printf '%s\n' "$want" > "$HOOK"; chmod +x "$HOOK"; did "instance repo post-commit (DB snapshots -> ~/nanoclaw-db-backups)"
  fi
fi

[ "$changed" = 1 ] && say "done." || say "already installed; nothing to do."
say "next: git config core.hooksPath should be .husky/_ (pnpm install sets it via husky)."
