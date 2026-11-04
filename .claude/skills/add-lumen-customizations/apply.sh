#!/bin/sh
# add-lumen-customizations driver: applies this fork's installable customizations, in order, with a
# typecheck/test checkpoint after each. Stops at the first conflict or failure and says where.
#
#   sh .claude/skills/add-lumen-customizations/apply.sh [--only <skill>] [--no-checks] [--skip-instance]
#
# Environment:
#   FORK_REMOTE              git remote that points at the fork holding the skill branches (default: origin)
#   NANOCLAW_INSTANCE_REPO   passed to add-instance-repo (default: ~/Projects/lumen-nanoclaw-instance)
#
# Run from the root of the NanoClaw checkout (or a worktree of it), on a clean working tree.
set -eu

ONLY=""; CHECKS=1; INSTANCE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift ;;
    --no-checks) CHECKS=0 ;;
    --skip-instance) INSTANCE=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
REMOTE="${FORK_REMOTE:-origin}"
SKILLS=".claude/skills"
log() { printf '\n== %s\n' "$*"; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

git diff --quiet && git diff --cached --quiet || { echo "working tree is not clean; commit or stash first" >&2; exit 1; }

checkpoint() {
  [ "$CHECKS" = 1 ] || return 0
  log "checkpoint after $1: host typecheck + tests"
  pnpm exec tsc --noEmit -p .
  pnpm exec vitest run --reporter=dot 2>&1 | tail -4
  if [ -d container/agent-runner ]; then
    log "checkpoint after $1: container typecheck + tests"
    (cd container/agent-runner && bun install --frozen-lockfile >/dev/null 2>&1)
    pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
    (cd container/agent-runner && bun test 2>&1 | tail -4)
  fi
}

commit_layer() { # name
  git add -A -- . ":!$SKILLS" 2>/dev/null || git add -A
  if git diff --cached --quiet; then return 0; fi
  git -c core.hooksPath=/dev/null commit -q -m "Apply $1 (add-lumen-customizations)"
  echo "committed layer: $1"
}

# apply_branch_skill <skill> <branch> <already-applied test command>
apply_branch_skill() {
  skill="$1"; branch="$2"; applied="$3"
  want "$skill" || return 0
  log "$skill"
  if sh -c "$applied" >/dev/null 2>&1; then echo "already applied; skipping"; return 0; fi
  [ -f "$SKILLS/$skill/files.txt" ] || { echo "missing $SKILLS/$skill/files.txt (bootstrap the skill folders first, see SKILL.md)" >&2; exit 1; }
  git fetch -q "$REMOTE" "$branch"
  while read -r f; do
    mkdir -p "$(dirname "$f")"
    git show "$REMOTE/$branch:$f" > "$f"
  done < "$SKILLS/$skill/files.txt"
  if ! git apply --3way "$SKILLS/$skill/shared-files.patch"; then
    echo "CONFLICT applying $skill: resolve the markers (intent table in $SKILLS/$skill/SKILL.md step 2), 'git add' them, then re-run" >&2
    exit 1
  fi
}

# ---- 1. instance repo (first: everything after writes into groups/ and the shim trees) -----------------
if want add-instance-repo && [ "$INSTANCE" = 1 ]; then
  log "add-instance-repo"
  sh "$SKILLS/add-instance-repo/install.sh"
  git add -A -- .gitignore .husky 2>/dev/null || true
  commit_layer add-instance-repo
fi

# ---- 2. host-shim layer ----------------------------------------------------------------------------------
apply_branch_skill add-host-scripts host-shim "test -f src/modules/host-shim/registry.ts && grep -q host_shims_dir src/types.ts"
if want add-host-scripts; then chmod +x src/host-shim-templates/*-host 2>/dev/null || true; commit_layer add-host-scripts; checkpoint add-host-scripts; fi

# ---- 3. host cron ---------------------------------------------------------------------------------------
apply_branch_skill add-host-cron host-cron "test -f src/modules/host-cron/run.ts && grep -q 'MODULE-HOOK:host-cron' src/host-sweep.ts"
if want add-host-cron; then commit_layer add-host-cron; checkpoint add-host-cron; fi

# ---- 4. memory stack -------------------------------------------------------------------------------------
apply_branch_skill add-memory-stack memory-stack "test -f src/modules/projected-sessions/synthesize.ts && grep -q projected_sessions_enabled src/container-runner.ts"
if want add-memory-stack; then
  chmod +x show-briefings.sh 2>/dev/null || true
  grep -q '"sharp"' package.json || pnpm add 'sharp@^0.35.3'
  commit_layer add-memory-stack
  checkpoint add-memory-stack
fi

log "done"
echo "Next: wire your groups and restart (see SKILL.md 'After applying'), then rebuild the image: ./container/build.sh"
