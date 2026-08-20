# Remove Host Scripts

Every step is idempotent — safe to re-run. Removes the module, its
container-side CLI, and every reach-in edit; does **not** roll back the
`host_shims_dir` column migration (forward-only, like every other
migration here) — a leftover column with no reader or writer is harmless.

**Check first:** does any group still depend on this? `add-projected-sessions`
(if applied) calls `execHostShim` for its `briefing-host` script — removing
this out from under it makes those calls fail closed (falls back to the
stored briefing, doesn't crash), but there's no reason to leave it half-wired.
Remove `add-projected-sessions` first if it's applied.

## 1. Remove the module, template, and container CLI

```bash
rm -rf src/modules/host-shim
rm -f src/host-shim-templates/briefing-host
rmdir src/host-shim-templates 2>/dev/null || true
rm -f src/db/migrations/021-host-shims-dir.ts
rm -f container/agent-runner/src/cli/host-shim.ts
```

## 2. Unregister the migration

Remove the `migration021` import and array entry from
`src/db/migrations/index.ts`.

## 3. Unregister the module

Remove `import './host-shim/index.js';` from `src/modules/index.ts`.

## 4. Drop `host_shims_dir` from the container-config type surface

- `src/types.ts` — remove the `host_shims_dir` field from `ContainerConfigRow`.
- `src/db/container-configs.ts` — remove `'host_shims_dir'` from
  `SCALAR_COLUMNS`; remove `host_shims_dir`/`@host_shims_dir` from
  `createContainerConfig`'s INSERT; remove `| 'host_shims_dir'` from
  `updateContainerConfigScalars`'s `Pick<...>` union.
- `src/backfill-container-configs.ts` — remove `host_shims_dir: null,`.
- Any test fixture you added `host_shims_dir: null,` to — remove it there
  too (`tsc --noEmit -p .` flags any you miss).

## 5. Remove the templates-dir constant

`src/config.ts` — remove the `HOST_SHIM_TEMPLATES_DIR` export.

## 6. Stop seeding new groups

`src/group-init.ts` — remove `HOST_SHIM_TEMPLATES_DIR` from the import and
the `host-shims/` seeding block from `initGroupFilesystem`.

## 7. Remove the CLI flag

`src/cli/resources/groups.ts` — remove `parseHostShimsDirFlag`, the
`host_shims_dir: row.host_shims_dir,` line from `presentConfig`, the
`| 'host_shims_dir'` union entry, the `--host-shims-dir` clause from the
description and the "nothing to update" error message, and the flag
parse block in the `config update` handler.

## 8. Remove the Dockerfile wrapper

`container/Dockerfile` — remove the `host-shim` CLI wrapper block (the
`RUN printf ... /usr/local/bin/host-shim ...` step).

## 9. Remove its recipe entry

```bash
sed -i.bak '/add-host-scripts/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

## 10. Build, test, rebuild image

```bash
pnpm exec tsc --noEmit -p .
pnpm test
./container/build.sh
```

## 11. Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```
