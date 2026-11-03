# Remove Host Scripts

Removes the host-shim layer: the module, templates, container-side CLI and
MCP forwarder, and every edit to NanoClaw-owned files. Does **not** roll back
the `host_shims_dir` / `mcp_shims_dir` column migrations (forward-only, like
every migration here) — leftover columns with no reader or writer are harmless.

**Check first:** `add-projected-sessions`, `add-host-cron` and
`add-vault-memory-pipeline` call `execHostShim`. Remove them first if applied;
otherwise their calls fail closed (briefing falls back to the stored one) with
nothing wired behind them.

## 1. Reverse the shared-file edits

```bash
git apply -R --3way .claude/skills/add-host-scripts/shared-files.patch
```

If upstream has moved and the reverse patch conflicts, undo each row of the
table in `SKILL.md` step 2 by hand (`tsc --noEmit -p .` flags what's left).

## 2. Delete the module-owned files

```bash
while read -r f; do rm -f "$f"; done < .claude/skills/add-host-scripts/files.txt
rmdir src/modules/host-shim src/host-shim-templates 2>/dev/null || true
```

`files.txt` lists exactly what step 1 of Apply copied in.

## 3. Remove the recipe entry

```bash
sed -i.bak '/add-host-scripts/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

## 4. Build, test, rebuild image

```bash
pnpm exec tsc --noEmit -p .
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

## 5. Restart

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Per-group `host-shims/` and `mcp-shims/` directories (including the pool and
registry) are user data and are left in place.
