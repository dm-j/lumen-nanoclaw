---
name: add-vault-memory-pipeline
description: Live per-turn vault transcript export plus scheduled daily and weekly/monthly digest generation — the host-shim scripts that turn NanoClaw's canonical conversation history into MBIF's hierarchical, wikilink-addressable vault format. Fork-specific feature (lumen-nanoclaw), not upstream NanoClaw.
---

# Add Vault Memory Pipeline

Three pieces, all host-shim scripts (see `/add-host-scripts`), all
already proven (either against a throwaway vault, or — for the rollup
prompt — against the real crontab job it's taken from) at authoring time:

1. **`transcript-append-host`** — every delivered/inbound chat turn is
   appended live to `07-Daily/Transcripts-readonly/YYYY/MM/DD.md`, no
   batching, no export step. No LLM call — a deterministic shell script.
2. **`digest-daily-host`** — scheduled once a day (via `/add-host-cron`),
   shells out to the `digester` subagent (seeded by `/add-mbif-vault`)
   against whatever `transcript-append-host` has written so far, producing
   `07-Daily/Digests-readonly/YYYY/MM/DD.md`.
3. **`digest-rollup-host`** — scheduled once a day, shells out to MBIF's
   *stock* `librarian` agent (no derivation needed — the entire rollup
   behavior lives in the prompt this script supplies) to roll the week's
   daily digests into `08-Weekly/Digests-readonly/WeekBeginning-YYYY-MM-DD.md`,
   and — once that week is actually over — append a compressed summary
   into `09-Monthly/Digests-readonly/Month-YYYY-MM.md`. The prompt is the
   real, currently-running crontab job for this exact task taken verbatim,
   plus one addition: `^mon`–`^sun` per-day block anchors (this project's
   own design decision, not yet present in the live vault's own output).

Together they close the write side of the vault memory pipeline that
`/add-projected-sessions`'s `briefing-host` reads from.

**If the vault a group points at already has its own system crontab doing
this same maintenance** (as this fork's own vault does): don't run both.
Decided plan — remove the crontab entries once this skill's scripts are
confirmed working for that vault, don't try to run them concurrently.
See "Migrating off an existing crontab" below.

## Migrating off an existing crontab

If a vault already has cron jobs doing what `transcript-append-host`,
`digest-daily-host`, and `digest-rollup-host` now do, identify which
crontab lines are actually superseded before touching anything — not
every line in a maintenance crontab is: only remove entries whose job
this skill's scripts now perform.

**Superseded (safe to remove once cutover is confirmed working):**
- Any `assemble-transcript <today> <yesterday>` line — replaced by
  `transcript-append-host`'s live per-turn append.
- Any `invoke-claude digester -- -p "...digesting yesterday's...raw
  transcript..."` line — replaced by `digest-daily-host`.
- Any `invoke-claude librarian -- -p "...Roll up this week's daily
  digests...append...to its monthly digest..."` line — replaced by
  `digest-rollup-host`.

**Not superseded — leave alone:** anything doing inbox triage (`sorter`),
blind-link promotion (`linker`), vault-wide dedup/maintenance (`scribe`),
skill-mining (`skill-drafter`), or unrelated housekeeping (a vault git
auto-commit, a sketch/intraday check). This skill only covers the
transcript-export → daily-digest → weekly/monthly-rollup chain, nothing
else a vault's crontab might be doing.

**Cutover order, per group:**
1. Apply this skill, configure `VAULT_PATH`/`VAULT_TIMEZONE` in all three
   scripts, wire the two `host-cron-jobs` (Apply step 7).
2. Let both paths run in parallel for at least one full day/week cycle —
   confirm `transcript-append-host` produces the same shape of output the
   crontab's `assemble-transcript` did, and that `digest-daily-host`/
   `digest-rollup-host` fire and produce correct files.
3. Only then remove the superseded crontab lines
   (`crontab -e`, delete just those lines — never `crontab -r`, which
   wipes the whole table including the unrelated jobs above).
4. Keep the old scripts (`assemble-transcript`, the crontab's inline
   prompts) around on disk even after removal — they're not deleted by
   this cutover, just no longer scheduled, in case of rollback.

## Pre-flight

### Verify dependencies are applied

```bash
test -f src/modules/host-shim/exec.ts && echo "add-host-scripts OK"
test -d src/modules/host-cron && echo "add-host-cron OK"
```

`add-host-cron` is only needed for scheduling `digest-daily-host` — the
transcript-append half has no scheduling dependency at all (it's called
from the existing message-delivery path, not a cron).

### Check if already applied

```bash
test -f src/host-shim-templates/transcript-append-host && test -f src/host-shim-templates/digest-daily-host && test -f src/host-shim-templates/digest-rollup-host && echo "ALREADY APPLIED"
```

## Apply

### 1. Copy the module and templates in

```bash
mkdir -p src/modules/vault-transcript
for f in \
  src/modules/vault-transcript/index.ts \
  src/host-shim-templates/transcript-append-host \
  src/host-shim-templates/digest-daily-host \
  src/host-shim-templates/digest-rollup-host \
; do
  git show origin/vault-memory-pipeline:"$f" > "$f"
done
chmod +x src/host-shim-templates/transcript-append-host src/host-shim-templates/digest-daily-host src/host-shim-templates/digest-rollup-host
```

### 2. Add `resolveAssistantName` (needed for outbound turn attribution)

Edit `src/container-config.ts` — add, after `resolveGroupTimezone`:

```typescript
/** Effective display name for an agent group's responder: assistant_name override → group name. */
export function resolveAssistantName(agentGroupId: string): string {
  const group = getAgentGroup(agentGroupId);
  return getContainerConfig(agentGroupId)?.assistant_name ?? group?.name ?? 'Assistant';
}
```

### 3. Add `timestamp` to `OutboundMessage`

Edit `src/db/session-db.ts` — the `SELECT *` already returns it, this
just types it:

```typescript
export interface OutboundMessage {
  id: string;
  kind: string;
  timestamp: string;
  // ...unchanged...
```

### 4. Wire the two per-turn call sites

Edit `src/container-runner.ts`'s `spawnContainer`, right after the
existing `agent_destinations` block:

```typescript
  // Live per-turn vault transcript export — no table/flag; unconditional
  // and cheap because execHostShim no-ops (a stat, not a spawn) when the
  // group has no transcript-append-host script.
  {
    const { appendPendingInboundTurns } = await import('./modules/vault-transcript/index.js');
    await appendPendingInboundTurns(agentGroup.id, session.id);
  }
```

Edit `src/delivery.ts`'s `drainSession`, right after `markDelivered(...)`
inside the per-message loop:

```typescript
        // Live per-turn vault transcript export — cheap no-op when the
        // group has no transcript-append-host script.
        if (msg.kind === 'chat') {
          const { appendDeliveredOutboundTurn } = await import('./modules/vault-transcript/index.js');
          const { resolveAssistantName } = await import('./container-config.js');
          void appendDeliveredOutboundTurn(
            session.agent_group_id,
            resolveAssistantName(session.agent_group_id),
            msg.timestamp,
            msg.content,
          );
        }
```

### 5. Seed all three scripts into every new group

Edit `src/group-init.ts` — extend the existing host-shim seeding loop
(originally just `briefing-host`) to also cover all three:

```typescript
  for (const shimName of ['briefing-host', 'transcript-append-host', 'digest-daily-host', 'digest-rollup-host']) {
```

### 6. Build and test

```bash
pnpm exec tsc --noEmit -p .
pnpm test
```

No container rebuild needed — nothing in `container/agent-runner/` changed.

### 7. Configure, ask what time the digest should run, and schedule per group

```sh
# groups/<folder>/host-shims/transcript-append-host — edit:
VAULT_PATH="<vault-path>"
VAULT_TIMEZONE="America/Chicago"   # or the group's own timezone

# groups/<folder>/host-shims/digest-daily-host — same two lines

# groups/<folder>/host-shims/digest-rollup-host — VAULT_PATH only, no timezone (librarian resolves "this week" itself)
```

Ask the operator: **"What time should the daily vault digest run?"**
(e.g. "12:05am", "1:30am" — this is when `digest-daily-host` processes
yesterday's transcript, in the group's own configured timezone). Default
to **12:05am** if they have no preference.

Convert whatever time is in effect to 5-field cron (`MM HH * * *`; e.g.
`12:05am` → `5 0`, `1:30am` → `30 1`) and use it below.
`digest-rollup-host`'s own schedule isn't part of this question — it
defaults to a fixed offset after the daily digest (the example below
keeps the ~3h15m gap the original crontab this is based on used between
its `digester` and `librarian` jobs, so the rollup reliably runs after
that day's digest exists) unless there's a reason to ask about it
separately too.

```bash
ncl host-cron-jobs create --id <group-id> --name digest-daily --cron "5 0 * * *"   # replace "5 0" with the converted answer
ncl host-cron-jobs create --id <group-id> --name digest-rollup --cron "0 4 * * *"
```

No `--args` needed for either — `digest-daily-host` computes "yesterday"
itself from its own `VAULT_TIMEZONE`, and `digest-rollup-host` asks
`librarian` to work out "this week" from its own clock, matching the
crontab job it's based on (both fire daily, not just on a boundary day —
that's what makes the incremental fill-in and "append to monthly once
the week is actually over" logic work).

## Customization levers

| Lever | Where | What it changes |
|---|---|---|
| Per-group vault path / timezone | `VAULT_PATH`/`VAULT_TIMEZONE` in each script (edited once per group, never overwritten again) | Which vault and which local calendar day a turn/digest lands in. |
| Digest schedule | `ncl host-cron-jobs create --cron "<expr>"` | When the daily digest runs. Default example fires at 00:45 local, after the day's transcript is done. |
| Backfill / manual digest run | `groups/<folder>/host-shims/digest-daily-host YYYY-MM-DD` (direct invocation) or `ncl host-cron-jobs run --job-id <id>` | Digest a specific past date instead of "yesterday". |
| Rollup schedule | `ncl host-cron-jobs create --name digest-rollup --cron "<expr>"` | When the weekly/monthly rollup runs. Default example mirrors the live crontab: daily at 4am, not just once a week — that's what lets the week file fill in incrementally each day. |
| The rollup prompt itself | `digest-rollup-host`'s embedded prompt string | Everything about what "roll up" means — which folders, the anchor format, the month-boundary rule — lives in this one string, not in code. Edit it directly to change behavior; no agent-file edit needed since `librarian` is unmodified MBIF stock. |
| Whether a turn gets exported at all | Presence of `transcript-append-host` in a group's whitelist folder | No table/flag — delete the script to turn transcript export off for a group; the call sites no-op cleanly. |

## Troubleshooting

- **Transcript file never appears.** Confirm `transcript-append-host`
  exists and is executable in the group's whitelist folder, and that
  `VAULT_PATH` was actually edited (it refuses to run on the placeholder).
  Check `logs/nanoclaw.log` for `transcript-append failed` (a real error)
  vs. no log line at all (script genuinely absent — expected no-op).
- **Digest never runs.** Check `ncl host-cron-jobs list --id <group-id>` —
  confirm a job exists and `next_run_at` is sane. See `/add-host-cron`'s
  own troubleshooting for the scheduling layer itself.
- **Digest script exits 0 but no digest file appears.** Check whether it
  logged "no transcript for `<date>`" (a quiet day — correct, not a bug)
  vs. actually invoking `digester` — if it invoked digester but no file
  appeared, that's a `/add-mbif-vault` / digester-prompt question, not
  this skill's.
- **A turn is missing or duplicated in the transcript.** See the known
  limitations in `src/modules/vault-transcript/index.ts`'s own header
  (occasional `'Unknown'` sender, rare crash-retry duplicate) — both
  accepted tradeoffs, fixable by hand in the vault file.
- **Weekly digest never appears, or is missing days.** Confirm
  `digest-rollup-host` actually ran (`ncl host-cron-jobs list --id <group-id>`)
  and that the daily digests it depends on exist for the days in
  question — `librarian` can only roll up what `digester` has already
  produced.
- **Weekly/monthly digest looks duplicated or double-appended after
  running both this and an external crontab against the same vault.**
  Expected if the cutover in "Migrating off an existing crontab" wasn't
  completed — remove the superseded crontab lines rather than running
  both indefinitely.

## Verify

```bash
ls -la groups/<folder>/host-shims/transcript-append-host groups/<folder>/host-shims/digest-daily-host groups/<folder>/host-shims/digest-rollup-host
tail -50 logs/nanoclaw.log | grep -i transcript-append
```

Send the group a message, confirm a line appears in that day's
`07-Daily/Transcripts-readonly/YYYY/MM/DD.md`. Force a digest run
(`ncl host-cron-jobs run --job-id <id>`) and confirm
`07-Daily/Digests-readonly/YYYY/MM/DD.md` appears with a categorized,
anchor-cited Event Log. Force a rollup run and confirm
`08-Weekly/Digests-readonly/WeekBeginning-YYYY-MM-DD.md` appears (or
gains a new day's subheader) with `^mon`–`^sun` anchors on each day's
paragraph.

## Removal

See [REMOVE.md](REMOVE.md). Does not roll back any migration (this
module doesn't own one — no table, by design).
