# Remove Projected Sessions

Every step is idempotent — safe to re-run. Removes the module and its two
hook lines; does **not** roll back the migration (forward-only, like every
other migration here) — the leftover `projected_sessions_enabled` and
`session_briefings` tables are harmless dead schema once nothing reads or
writes them.

## 0. Disable any group using it first

```bash
ncl projected-sessions list
ncl projected-sessions disable --id <group-id>
ncl groups restart --id <group-id>
```

## 1. Remove the module and its migration

```bash
rm -f src/db/migrations/025-projected-sessions.ts
rm -rf src/modules/projected-sessions
rm -f container/agent-runner/src/projected-sessions.ts
```

## 2. Unregister the migration

Remove the import and the array entry for `migration025` from
`src/db/migrations/index.ts`.

## 3. Unregister the module

Remove `import './projected-sessions/index.js';` from `src/modules/index.ts`.

## 4. Remove the per-wake hook

Remove the `hasTable(getDb(), 'projected_sessions_enabled')` block from
`src/container-runner.ts`'s `spawnContainer` (the block added right after
the existing `agent_destinations` block — leave that one alone).

## 5. Revert host-shim's timeout parameter

`src/modules/host-shim/exec.ts` — remove the `timeoutMs = TIMEOUT_MS`
parameter from `execHostShim` and use `TIMEOUT_MS` directly in the
`execFile` options again. Check for other callers passing a 4th argument
first (`grep -rn 'execHostShim(' src/`) in case another skill has since
started using it.

## 6. Revert the container-side runner

`container/agent-runner/src/poll-loop.ts` — remove the `isProjectedSession`
import, the `projected` local and its two uses (continuation-load line
reverts to `let continuation: string | undefined =
migrateLegacyContinuation(config.providerName);`; continuation-store `if`
drops the `!projected &&` clause), and the `!isProjectedSession()` guard on
the other `setContinuation` call site.

`container/agent-runner/src/formatter.ts` — remove the
`projectedContextHeader` import and revert `formatMessages`'s header line
to `` const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`; ``.

## 7. Remove its recipe entry

```bash
sed -i.bak '/add-projected-sessions/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

Leave the recipe file itself in place even if this was its only entry —
other skills may have appended to it since, and an empty "Applied skills"
section is harmless.

## 8. Build, test, rebuild image

```bash
pnpm exec tsc --noEmit -p .
pnpm test
./container/build.sh
```

## 9. Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
