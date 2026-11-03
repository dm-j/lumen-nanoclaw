# Remove Host Cron

Removes the `host-cron` module and its edits to NanoClaw-owned files. Does
**not** roll back the migration (forward-only, like every migration here) — a
leftover `host_cron_jobs` table with no reader or writer is harmless. Delete
any jobs first (`ncl host-cron-jobs delete --job-id <id>`) if you want a clean
stop rather than pulling the clock out from under scheduled rows.

**Check first:** does `add-vault-memory-pipeline` still rely on it? Its digest
jobs are host-cron rows; remove that skill first if applied.

## 1. Reverse the shared-file edits

```bash
git apply -R --3way .claude/skills/add-host-cron/shared-files.patch
```

If upstream moved and it conflicts: remove the `026-host-cron` registration
from `src/db/migrations/index.ts`, `import './host-cron/index.js';` from
`src/modules/index.ts`, and the `MODULE-HOOK:host-cron` block (and the
`getDb, hasTable` import if nothing else uses it) from `src/host-sweep.ts`.

## 2. Delete the module-owned files

```bash
while read -r f; do rm -f "$f"; done < .claude/skills/add-host-cron/files.txt
rmdir src/modules/host-cron 2>/dev/null || true
```

## 3. Remove the recipe entry

```bash
sed -i.bak '/add-host-cron/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

## 4. Build, test, restart

```bash
pnpm exec tsc --noEmit -p .
pnpm test
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
