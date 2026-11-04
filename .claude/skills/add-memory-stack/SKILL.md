---
name: add-memory-stack
description: Use when the user wants the agent memory system on a fork: projected sessions (briefing + literal tail instead of transcript resume), the live vault transcript export, image attachment captioning, and the remember/recall tools, and the per-group wake script (pinned context). Also use when re-applying this fork's memory features onto a fresh NanoClaw.
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
5. **Wake script — pinned context** (`container_configs.wake_script`,
   migration `034-wake-script`, `ncl groups config update --wake-script`).
   A bash script run in the container at the start of **every** wake,
   whatever triggered it (a task fire, an `assign_task` session, a chat
   message). Its last stdout line is JSON `{"wakeAgent": bool, "data"?: any}`;
   `data` is rendered at the top of that turn's prompt inside
   `<wake-context>…</wake-context>`. It costs no model tokens, and a failing
   script just adds nothing. Combined with MCP tools that edit what the script
   reads, the agent can **pin** things it must not lose: see "Pinning" below.
6. **Plumbing bundled because it is interleaved with the above:**
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
tasks, Telegram, message `subject`, approval expiry,
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
`blockedHosts`, `resolveAssistantName`), `src/config.ts` (`LOGS_DIR`), the `wake_script` column plumbing (`src/types.ts`,
`src/db/container-configs.ts`, `src/backfill-container-configs.ts`,
`src/cli/resources/groups.ts` `--wake-script`, `migration 034`),
`src/timezone.ts` (`formatLocalIsoOffset`), `src/cli/resources/sessions.ts`
(`sessions sync-briefing`), `src/modules/index.ts`,
`src/db/migrations/index.ts` (025, 027, 028, 030, 034), and container
`poll-loop.ts` (also the wake-script run), `config.ts`, `index.ts`,
`formatter.ts`, `memory/*`, `mcp-tools/index.ts`, plus tests.

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

## Pinning with the wake script

The wake script is how an agent keeps something in front of itself across
turns, sessions and container restarts, without depending on conversation
history. The pattern this fork uses (`wake-script.notes.example.sh`, in this
skill's folder):

1. The script runs `host-shim notes/read`, which returns today's ID'd notes
   from the vault daily note's `## Notes` block (`[id] text`, one per line),
   truncates it to 4000 characters, prefixes today's date and a standing
   instruction ("delete a note when it is no longer useful"), and prints the
   JSON line.
2. The agent maintains the block with the **`notes_*` MCP tools**:
   `notes_add` (returns the ID), `notes_edit`, `notes_delete`, `notes_read`.
   Anything added is in context from the next wake onward; deleting it
   un-pins it.

The scripts behind the tools are *instance* files, not NanoClaw code: the pooled
`notes` mcp-shim server (`mcp-shims/_pool/notes/`, with `notes-block.ts` in
`mcp-shims/lib/`) and the `notes/read` shim, allowed per group in
`mcp-shims/_registry.json` / `host-shims/_registry.json` (`NOTES_WHO` names the
agent). They live in the private instance repo and are listed in
`docs/mcp-shims-inventory.md`. Re-applying this skill gives you the wake-script
mechanism; the notes tools come back with the instance repo.

```bash
ncl groups config update --id <group-id> --wake-script "$(cat .claude/skills/add-memory-stack/wake-script.notes.example.sh)"
ncl groups restart --id <group-id>      # takes effect on the next container
```

Design notes: keep the output small (it is paid for in every wake's context, so
cap it as the example does); the script has a 30 s limit (the same runner as
task scripts); it runs with the container's environment, so `host-shim` and `node`
are on PATH; `wakeAgent` is read by task scripts but the wake path only uses
`data`.

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
