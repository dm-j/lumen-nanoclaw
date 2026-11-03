---
name: add-memory-stack
description: Use when the user wants the agent memory system on a fork: projected sessions (briefing + literal tail instead of transcript resume), the live vault transcript export, image attachment captioning, and the remember/recall tools. Also use when re-applying this fork's memory features onto a fresh NanoClaw.
---

# Add Memory Stack

Installs the whole **memory system** as one unit. It replaces the old pair
`add-projected-sessions` + `add-vault-memory-pipeline` as the way to *install*
these features (those two now only carry operating docs). They could not stay
separate: the code is one subsystem.

- `vault-transcript` imports `attachment-caption` (image resize/caption) and
  `projected-sessions/literal-tail` (attachment text); `attachment-caption/notify`
  imports `vault-transcript` back.
- `wakeContainer`, `router.ts`, `session-manager.ts`, `formatter.ts` and
  `poll-loop.ts` carry edits for all of them in the same functions.

## What you get

1. **Projected sessions** (`src/modules/projected-sessions/`, container
   `projected-sessions.ts`). Opt-in per group: instead of resuming a growing
   provider transcript, every wake the host compiles a rolling **briefing**
   (the group's `briefing-host` shim, a `claude -p` subagent) plus a **literal
   tail** of recent turns, and the container prepends both. Tails grow with a
   prefix-cache-aware anchor (`N → 2N → truncate`); a warm container is reset
   after a follow-up count or cache-TTL so context cannot grow forever. See
   `add-projected-sessions` for wiring and tuning.
2. **Vault transcript export** (`src/modules/vault-transcript/`). Opt-in per
   group: every delivered/inbound chat turn is appended live to the vault's
   `07-Daily/Transcripts-readonly/YYYY/MM/DD.md` by `transcript-append-host`.
   Digests are scheduled separately (see `add-vault-memory-pipeline`).
3. **Attachment captioning** (`src/modules/attachment-caption/`). Image
   attachments get a caption id at routing time and are captioned off the
   delivery path; originals are archived to the group workspace; the resized
   copy goes to the transcript. Needs the `sharp` dependency.
4. **remember / recall MCP tools** (`container/.../mcp-tools/memory-fact.ts`):
   ad-hoc vault fact capture and retrieval through the `remember-host` /
   `recall-host` shims.
5. **Plumbing bundled because it is interleaved with the above:**
   - **Staged inbound rows.** A wake-triggering message is written `staged`,
     the host finishes the briefing, then `releaseStagedMessage` flips it to
     `pending`, so an already-warm container cannot race the compile.
     `host-sweep.ts` recovers rows stuck `staged`.
   - **Gated-task briefing deferral.** A cold wake whose whole batch is
     `--script`-gated task rows skips the (paid) briefing compile and drops
     `.needs-briefing-sync`; the container runs `ncl sessions sync-briefing`
     only if the gate lets the task through.
   - **Idle-reap and projected-reset logging** demoted from warnings
     (`container-runner.ts`, `host-sweep.ts`).
   - **Inference headers:** `x-agent-group` on every container, plus
     `x-session-id` for projected sessions (keys PrefixRouter's cache
     tracking).
   - **Per-group `env` / `blockedHosts`** in `container.json`, preserved
     across regeneration (host-local model routing).
   - **Operator aids:** `show-briefings.sh`, `/workspace/last-prompt.md`.

**Not included** (separate features, listed in `docs/local-modifications.md`):
session-sync, follow-up timer, agent-to-agent loop guards, stateless scheduled
tasks, per-group wake script, Telegram, message `subject`, approval expiry,
delivery retry, `DEFAULT_AGENT_MODEL` seeding, the last-context dump.

**Dead files:** migrations `022-session-lifecycle`, `023-session-briefings` and
`024-tail-anchors` exist in the fork's tree but are registered nowhere
(superseded by `025-projected-sessions`). Do not copy them.

## Depends on

`add-host-scripts` (host-shim layer; the briefing, transcript and recall shims
are its templates). `add-host-cron` only matters for scheduling digests.

## Pre-flight

```bash
test -f src/modules/host-shim/registry.ts && echo "add-host-scripts OK"
test -f src/modules/projected-sessions/synthesize.ts && grep -q projected_sessions_enabled src/container-runner.ts && echo "ALREADY APPLIED — skip to Verify"
git fetch origin memory-stack && git log -1 --oneline origin/memory-stack
```

## Apply

The module-owned files are on the `memory-stack` branch (list: `files.txt`).
Edits to NanoClaw-owned files are in `shared-files.patch`, generated from a
clean checkout of the fork's upstream base with `add-host-scripts` and
`add-host-cron` applied, and proven there (typecheck + full host and container
test suites).

### 1. Copy the module-owned files in

```bash
while read -r f; do
  mkdir -p "$(dirname "$f")"
  git show "origin/memory-stack:$f" > "$f"
done < .claude/skills/add-memory-stack/files.txt
chmod +x show-briefings.sh
```

### 2. Apply the shared-file patch

```bash
git apply --3way .claude/skills/add-memory-stack/shared-files.patch
```

`--3way` leaves conflict markers where upstream moved; resolve by intent. The
patch touches: `src/container-runner.ts` (async `wakeContainer`: transcript
append, deferred/awaited synth, headers, env/blockedHosts, reset logging),
`src/router.ts` (caption stamp, staged write, caption trigger, release),
`src/session-manager.ts` (`stage` option, `releaseStagedMessage`, original-image
archive), `src/delivery.ts` (vault transcript hook with recipient name),
`src/db/session-db.ts` (`dueMessagesAreAllGatedTasks`, outbound `timestamp`),
`src/host-sweep.ts`, `src/container-config.ts` (`sessionLifecycle`, `env`,
`blockedHosts`, `resolveAssistantName`), `src/config.ts` (`LOGS_DIR`),
`src/timezone.ts` (`formatLocalIsoOffset`), `src/cli/resources/sessions.ts`
(`sessions sync-briefing`), `src/modules/index.ts`,
`src/db/migrations/index.ts` (025, 027, 028, 030), and container
`poll-loop.ts`, `formatter.ts`, `memory/*`, `mcp-tools/index.ts`, plus tests.

**Migration numbers** are ordering hints only; identity is the migration
`name`, so reuse of numbers upstream already uses is safe. Alias imports on
identifier collisions; never rename an applied migration.

### 3. Add the one dependency

```bash
pnpm add sharp@^0.35.3
```

(`pnpm-lock.yaml` is not part of the patch — let pnpm regenerate it. The repo's
supply-chain rules apply: `minimumReleaseAge`, no new `onlyBuiltDependencies`.)

### 4. Build and test

```bash
pnpm exec tsc --noEmit -p .
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)
./container/build.sh
```

### 5. Record this in the fork's recipe

```bash
grep -q 'add-memory-stack' .claude/skills/recipe/SKILL.md 2>/dev/null || \
  echo "- [add-memory-stack](../add-memory-stack/SKILL.md) — applied $(date +%F) — memory system: projected sessions, vault transcript export, attachment captioning, remember/recall; supersedes add-projected-sessions + add-vault-memory-pipeline as the installer" \
  >> .claude/skills/recipe/SKILL.md
```

## Wire a group

```bash
ncl projected-sessions enable --id <group-id>      # briefing + literal tail
ncl vault-transcripts enable --id <group-id>       # live transcript export
ncl groups restart --id <group-id>
```

Both are off by default. The group also needs working shims
(`briefing-host`, `transcript-append-host`, `recall-host`, `remember-host`) with
`VAULT_PATH` set — via the registry env or an edited private copy (see
`add-host-scripts`). Tuning knobs: `add-projected-sessions`. Scheduling digests
and migrating off a crontab: `add-vault-memory-pipeline`.

## Verify

```bash
ncl projected-sessions list
ls data/v2-sessions/<agent-group-id>/<session-id>/briefing.md recent-turns.md
tail -50 logs/nanoclaw.log | grep -i "briefing\|transcript"
```

A real end-to-end check needs a live group: enable both, send a message, and
confirm a briefing file appears and the vault day file gains the turn.

## Removal

See [REMOVE.md](REMOVE.md).
