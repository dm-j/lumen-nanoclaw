#!/bin/sh
# rotate-logs.sh — weekly copy-and-truncate rotation for the host logs, keeping the newest $KEEP gzipped copies.
# Copy-truncate, not rename: launchd holds nanoclaw.log / nanoclaw.error.log open for the life of the service.
# ponytail: lines written between the copy and the truncate are lost (milliseconds); logrotate-style copytruncate has the same ceiling.
# Usage: scripts/rotate-logs.sh [logdir]
DIR=${1:-"$(cd "$(dirname "$0")/.." && pwd)/logs"}
KEEP=${ROTATE_KEEP:-8}
stamp=$(date -u +%Y%m%dT%H%M%SZ)

for f in "$DIR/nanoclaw.log" "$DIR/nanoclaw.error.log" "$DIR/net/netwatch.log"; do
  [ -s "$f" ] || continue
  gzip -c "$f" > "$f.$stamp.gz" && : > "$f" || { echo "rotate failed: $f" >&2; rm -f "$f.$stamp.gz"; continue; }
  # newest $KEEP archives stay; names sort by timestamp
  ls -1 "$f".*.gz | sort -r | tail -n +$((KEEP + 1)) | while IFS= read -r old; do rm -f "$old"; done
  echo "rotated $f -> $f.$stamp.gz"
done
