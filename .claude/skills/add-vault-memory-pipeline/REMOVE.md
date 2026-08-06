# Remove Vault Memory Pipeline

Every step is idempotent — safe to re-run. Migration 030
(`vault_transcript_enabled`, fork-local addition 2026-08-06) does own a
table — step 1b below.

**First:** remove any scheduled digest job so it isn't left calling a
script you're about to delete:

```bash
ncl host-cron-jobs list --id <group-id>
ncl host-cron-jobs delete --job-id <id>
```

## 1. Remove the module and templates

```bash
rm -rf src/modules/vault-transcript
rm -f src/host-shim-templates/transcript-append-host
rm -f src/host-shim-templates/digest-daily-host
rm -f src/host-shim-templates/digest-rollup-host
```

## 1b. Remove the migration and un-register the module

- Delete `src/db/migrations/030-vault-transcript-enabled.ts` and its
  import + array entry in `src/db/migrations/index.ts`.
- Remove the `import './vault-transcript/index.js';` line from
  `src/modules/index.ts`.
- The `vault_transcript_enabled` table itself has no down-migration —
  drop it by hand if you want it gone from an already-migrated DB
  (`pnpm exec tsx scripts/q.ts data/v2.db "DROP TABLE vault_transcript_enabled"`);
  otherwise it's just an orphaned, harmless table.

## 2. Remove `resolveAssistantName`

Remove the function from `src/container-config.ts` — check nothing else
started using it first (`grep -rn 'resolveAssistantName' src/`).

## 3. Revert `OutboundMessage`

Remove `timestamp: string;` from the interface in `src/db/session-db.ts`
— check nothing else started reading `msg.timestamp` off an
`OutboundMessage` first.

## 4. Remove the two call sites

`src/container-runner.ts` — remove the `vault-transcript` block added
after the `agent_destinations` hook in `spawnContainer`.

`src/delivery.ts` — remove the `if (msg.kind === 'chat') { ... }` block
added after `markDelivered` in `drainSession`.

## 5. Stop seeding new groups

`src/group-init.ts` — remove `'transcript-append-host'`,
`'digest-daily-host'`, and `'digest-rollup-host'` from the shim-seeding
loop's array (leave `'briefing-host'` alone unless
`/add-projected-sessions` is also being removed).

## 6. Build and test

```bash
pnpm exec tsc --noEmit -p .
pnpm test
```

No container rebuild needed.

## 7. Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
