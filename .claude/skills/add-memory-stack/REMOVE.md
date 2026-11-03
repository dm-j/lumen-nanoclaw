# Remove Memory Stack

Removes the projected sessions, vault transcript export, attachment captioning
and remember/recall code and every edit to NanoClaw-owned files. Does **not**
roll back migrations 025/027/028/030 (forward-only, like every migration here);
leftover tables (`projected_sessions_enabled`, `session_briefings`,
`vault_transcript_enabled`, …) with no reader or writer are harmless.

**Before removing:** disable the features per group so nothing is left half
wired (`ncl projected-sessions disable --id <g>`, `ncl vault-transcripts disable
--id <g>`), and restart the groups.

## 1. Reverse the shared-file edits

```bash
git apply -R --3way .claude/skills/add-memory-stack/shared-files.patch
```

If upstream moved and the reverse patch conflicts, undo by intent using the
file list in `SKILL.md` step 2 (`tsc` flags what is left).

## 2. Delete the module-owned files

```bash
while read -r f; do rm -f "$f"; done < .claude/skills/add-memory-stack/files.txt
rmdir src/modules/projected-sessions src/modules/attachment-caption src/modules/vault-transcript 2>/dev/null || true
```

## 3. Drop the dependency and the recipe entry

```bash
pnpm remove sharp
sed -i.bak '/add-memory-stack/d' .claude/skills/recipe/SKILL.md && rm -f .claude/skills/recipe/SKILL.md.bak
```

## 4. Build, test, rebuild image, restart

```bash
pnpm exec tsc --noEmit -p .
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Vault files already written (`07-Daily/Transcripts-readonly/`, digests) and each
group's `groups/<folder>/attachments/` archive are user data and are left alone.
