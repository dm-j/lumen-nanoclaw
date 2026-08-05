#!/bin/sh
# show-briefings.sh — print the last N compiled briefings for an agent group.
# Usage: ./show-briefings.sh <agent-group-name-or-folder-or-id> [N=5]
set -eu
cd "$(dirname "$0")"
exec pnpm exec tsx scripts/show-briefings.ts "$@"
