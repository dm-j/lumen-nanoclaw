#!/usr/bin/env bash
# Nightly encrypted backup of what is NOT recoverable from GitHub. Slim sibling of lumen-backup.sh (the full
# pre-wipe snapshot): skips reinstallable tooling (groups/*/{.tools,tools,.venv}, vault .claude/worktrees, node_modules) and git history.
# Output: $DEST/lumen-<UTC stamp>.tgz.enc  (AES-256, passphrase from $PASSFILE). Keeps the newest $KEEP.
# Restore: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:PASSFILE -in X.tgz.enc | tar -xz
# The passphrase file lives on this Mac -- ALSO keep the passphrase in your password manager, or a lost Mac
# means an undecryptable backup.
set -uo pipefail

DEST="${LUMEN_BACKUP_DEST:-$HOME/Dropbox/lumen-backup}"
PASSFILE="${LUMEN_BACKUP_PASSFILE:-$HOME/.config/lumen-backup/passphrase}"
KEEP="${LUMEN_BACKUP_KEEP:-14}"
P="$HOME/Projects"; TRUNK="$P/lumen-nanoclaw"
log() { echo "$(date -u +%FT%TZ) $*"; }

# Never create DEST's parent: a missing/unmounted drive or an uninstalled Dropbox must not fill the internal disk.
[ -d "$(dirname "$DEST")" ] || { log "SKIP: $(dirname "$DEST") does not exist (drive unmounted / Dropbox missing)"; exit 1; }
[ -s "$PASSFILE" ] || { log "FAIL: no passphrase file at $PASSFILE"; exit 1; }
mkdir -p "$DEST"

umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
S="$W/s"; mkdir -p "$S/data"
STAMP=$(date -u +%Y%m%dT%H%MZ)

sqlite3 "$TRUNK/data/v2.db" ".backup '$S/data/v2.db'" || { log "FAIL: v2.db backup"; exit 1; }  # consistent while host runs
cp "$TRUNK/.env" "$S/trunk.env"
cp "$HOME"/.ssh/id_ed25519* "$S/" 2>/dev/null || true
cp -R "$HOME/.onecli" "$S/onecli-config" 2>/dev/null || true
if docker compose -f "$HOME/.onecli/docker-compose.yml" exec -T postgres pg_dump -U onecli --clean --if-exists onecli > "$S/onecli.sql" 2>/dev/null; then :; else log "WARN: OneCLI dump skipped (docker down?)"; rm -f "$S/onecli.sql"; fi

tar -czf "$S/instance.tgz" -C "$P" --exclude='.git' --exclude='node_modules' --exclude='groups/*/.tools' --exclude='groups/*/tools' --exclude='groups/*/.venv' lumen-nanoclaw-instance
tar -czf "$S/prefixrouter.tgz" -C "$P" --exclude='node_modules' --exclude='logs' PrefixRouter   # keeps .git: it has no remote
tar -czf "$S/vault.tgz" -C "$P" --exclude='.DS_Store' --exclude='.claude/worktrees' obsidian/lumen-data                        # keeps .git: it has no remote
tar -C "$TRUNK" -czf "$S/data.tgz" --exclude='*.sock' --exclude='v2.db*' data 2>/dev/null || true

OUT="$DEST/lumen-$STAMP.tgz.enc"
tar -C "$W" -cz s | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE" -out "$OUT.part" || { log "FAIL: encrypt"; exit 1; }
# prove it decrypts and lists before we trust it (or delete the previous copies)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASSFILE" -in "$OUT.part" | tar -tz >/dev/null || { log "FAIL: verify"; rm -f "$OUT.part"; exit 1; }
mv "$OUT.part" "$OUT"
ls -1t "$DEST"/lumen-*.tgz.enc | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
log "OK $OUT $(du -h "$OUT" | cut -f1)"
