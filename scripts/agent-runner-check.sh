#!/bin/bash
#
# Typecheck + test container/agent-runner without installing Bun locally.
# Runs through the exact Bun version container/Dockerfile pins (read from
# its BUN_VERSION ARG, not duplicated here) — no drift, nothing to keep
# in sync by hand. See docs/build-and-runtime.md.
#
# Usage:  ./scripts/agent-runner-check.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BUN_VERSION="$(sed -n 's/^ARG BUN_VERSION=\(.*\)/\1/p' container/Dockerfile)"
if [[ -z "$BUN_VERSION" ]]; then
  echo "Couldn't find ARG BUN_VERSION= in container/Dockerfile" >&2
  exit 1
fi
echo "==> Using oven/bun:${BUN_VERSION} (pinned in container/Dockerfile)"

docker run --rm \
  -v "$(pwd):/repo" \
  -w /repo/container/agent-runner \
  "oven/bun:${BUN_VERSION}" \
  sh -c "bun install && bun run typecheck && bun test"
