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

**A real operational note, not resolved here:** if the vault a group
points at is *also* maintained by an existing system crontab doing this
same rollup (as this fork's own vault is), both `digest-rollup-host` and
the crontab job can end up running against the same files. Librarian's
own idempotency (create-if-absent, fill-in-only-what's-missing) should
make double-running harmless, but this hasn't been verified under actual
concurrent execution — if a group's vault has its own crontab already
doing this, prefer disabling one path rather than assuming both are
perfectly safe together.

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

### 7. Configure and schedule per group

```sh
# groups/<folder>/host-shims/transcript-append-host — edit:
VAULT_PATH="<vault-path>"
VAULT_TIMEZONE="America/Chicago"   # or the group's own timezone

# groups/<folder>/host-shims/digest-daily-host — same two lines

# groups/<folder>/host-shims/digest-rollup-host — VAULT_PATH only, no timezone (librarian resolves "this week" itself)
```

```bash
ncl host-cron-jobs create --id <group-id> --name digest-daily --cron "45 0 * * *"
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
  See the SKILL's own "real operational note" above — this combination
  is untested; disable one path.

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
