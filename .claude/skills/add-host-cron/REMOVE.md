# Remove Host Cron

Every step is idempotent — safe to re-run. Does **not** roll back the
`host_cron_jobs` migration (forward-only, like every migration here) — a
leftover table with no reader or writer is harmless.

**First:** delete any scheduled jobs so nothing is silently orphaned —
`ncl host-cron-jobs list` then `ncl host-cron-jobs delete --job-id <id>`
for each. Not strictly required (removing the tick mechanism makes the
rows inert either way), but cleaner.

## 1. Remove the module

```bash
rm -rf src/modules/host-cron
rm -f src/db/migrations/026-host-cron.ts
```

## 2. Unregister the migration

Remove the `migration026` import and array entry from
`src/db/migrations/index.ts`.

## 3. Unregister the module

Remove `import './host-cron/index.js';` from `src/modules/index.ts`.

## 4. Remove the sweep hook

Remove the `MODULE-HOOK:host-cron:start` … `:end` block from
`src/host-sweep.ts`'s `sweep()`. Leave the `getDb`/`hasTable` import if
anything else in the file still needs it (check before removing).

## 5. Leave `execHostShim`'s `timeoutMs` parameter alone

Unless you know nothing else uses it (`grep -rn 'execHostShim(' src/` and
check for other 4-arg callers — `add-projected-sessions` also uses it),
don't revert step 5 of the Apply instructions. It's backward-compatible
and harmless to leave even with `host-cron` gone.

## 6. Remove its recipe entry

```bash
sed -i.bak '/add-host-cron/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

## 7. Build and test

```bash
pnpm exec tsc --noEmit -p .
pnpm test
```

No container rebuild needed — this module is host-side only, nothing in
`container/agent-runner/` references it.

## 8. Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
