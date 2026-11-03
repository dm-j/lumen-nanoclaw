# Local modifications: re-apply guide

What this install changed in NanoClaw's own code (not skill-installed channels or providers), grouped by feature, with enough detail to re-apply each one onto a fresh upstream. It complements two other records:

- [`.claude/skills/recipe/SKILL.md`](../.claude/skills/recipe/SKILL.md) is the ledger of *skills* applied, in order.
- [`docs/local-patch-notes.md`](local-patch-notes.md) is the history by calendar day.

This file is organised by feature, so that after an upstream update you can walk it top to bottom. For each entry: find where upstream moved the touched code, re-apply the change, run the test named in the entry. Commit hashes are in this repo's history (`git show <hash>`), so `git cherry-pick <hash>` is the first thing to try.

Entries below cover changes that had no other write-up. Features that already have their own docs are listed under *Documented elsewhere* at the end.

## Message subject (internal transcript label), `fc70677c`

- **What:** agents add a 2–5 word `subject` to each reply. The recipient never sees it. It is printed after the header line in the vault transcript (`> **Lumen → DMJ — <ts>** Dinner plans`) to help search when memories are created. Inbound turns get none.
- **Why:** transcripts had nothing to key a search on; the prompt tells agents it is *not* context for the recipient, so each message must stand alone.
- **Touches:** `container/agent-runner/src/mcp-tools/core.ts` (`send_message` param), `container/agent-runner/src/poll-loop.ts` (`MESSAGE_RE` accepts `subject="…"`, `sendToDestination` stores it, `autoAppendTaskLog` regex), `container/agent-runner/src/destinations.ts` (the system-prompt addendum: "Always add `subject=…`"), `src/modules/vault-transcript/transcript.ts` (`parseChatContent` returns it; `appendDeliveredOutboundTurn` passes it as shim arg 5), `src/host-shim-templates/transcript-append-host` plus every deployed copy (header line gets `${SUBJECT:+ ${SUBJECT}}`).
- **Re-apply notes:** the outbound content is `{ text, subject }`; delivery ignores unknown keys, so nothing upstream needs to know. Deployed shim copies are never auto-updated (see [host-shims.md](host-shims.md)); old copies ignore arg 5 and simply omit the subject.
- **Also in this commit:** an unknown `<message to="X">` name now falls back to the channel the current batch came from (`findByRouting` in `dispatchResultText`) instead of dropping the reply. Cause: a fresh session guessed the person's display name as the destination. Test: `integration.test.ts` "unknown destination falls back to the batch origin".
- **Related data fix (not code):** the Telegram messaging group had a null `name`, so the destination label was opaque. `ncl messaging-groups update --id <mg> --name "<who>"` gives the agent a readable label.

## Telegram ordered delivery retry, `67262a80`

- **What:** a transient Telegram failure (`NetworkError`, `AdapterRateLimitError`) retries forever with the delay growing 5 s per failure up to 60 s. While an earlier Telegram message is retrying, later ones are held with no delay of their own; once released they are tried at the next poll tick, and a failure there starts its own 5 s backoff. Non-transient errors keep the 3-attempt cap.
- **Why:** a 36 s Telegram-only outage (2026-11-03) exhausted the old 3 attempts in ~22 s and dropped a reply for good.
- **Touches:** new `src/delivery-retry.ts` (+ `delivery-retry.test.ts`); `src/delivery.ts` `drainSession` (hold check before the send, `recordDone` on success and on give-up, a transient branch in `catch`, `pruneSession` after reading undelivered).
- **Re-apply notes:** state is in memory (a host restart resets it); entries are pruned when their message is no longer pending in the session. Classification is by `constructor.name` (verified against `@chat-adapter/shared`), because `@chat-adapter/shared` is not a direct dependency. Other channels are untouched. Open items live in [roadmap/delivery-retry-window.md](roadmap/delivery-retry-window.md).

## Telegram polling diagnostics and netwatch, `b6650ea3`, `de91df72`

- **What:** the host logs the underlying cause and duration of Telegram fetch failures (never the token-bearing URL). `scripts/netwatch.sh` probes the router, 1.1.1.1 and `https://api.telegram.org/` every 60 s (30 s while anything is down) and logs `DOWN`/`RECOVERED` events to `logs/net/netwatch.log`.
- **Why:** the Chat SDK adapter swallows the fetch error, so failures could not be explained. The separate Telegram probe tells link problems from Telegram-path problems.
- **Touches:** `src/channels/telegram.ts` (wraps the adapter's fetch to log method, duration and cause) and `src/channels/telegram-fetch-logging.test.ts`. `telegram.ts` is a skill-installed file (`/add-telegram`), so re-apply this after the skill, not onto trunk. Also `scripts/netwatch.sh`. Run as a launchd job *outside the repo*: `~/Library/LaunchAgents/com.nanoclaw.netwatch.plist`. Env knobs: `NETWATCH_ROUTER`, `NETWATCH_INTERNET`, `NETWATCH_TELEGRAM`, `NETWATCH_SLOW`, `NETWATCH_FAST`.

## Operational scripts and launchd jobs (outside the repo)

- `scripts/rotate-logs.sh` (`55f4a440`): weekly copy-truncate of `nanoclaw.log`, `nanoclaw.error.log`, `net/netwatch.log`; gzips and keeps the newest 8. Scheduled by `com.nanoclaw.rotate-logs` (Sundays 04:23).
- `scripts/lumen-nightly-backup.sh` (`de91df72`) and `scripts/lumen-backup.sh` (`42ea4db5`, with the `docs/fresh-install*.md` docs): encrypted backup of what is not recoverable from GitHub; passphrase file at `~/.config/lumen-backup/passphrase`. As of 2026-11-03 no launchd job runs the nightly script (none is loaded and none is in `~/Library/LaunchAgents/`); see [roadmap/scheduled-offsite-backup.md](roadmap/scheduled-offsite-backup.md).
- The launchd plists live in `~/Library/LaunchAgents/` and are **not in git**. After a machine move, recreate them: `com.nanoclaw-v2-<slug>` (host; the slug is `sha1(projectRoot)[:8]`, so it changes if the checkout path changes), `com.nanoclaw.netwatch`, `com.nanoclaw.rotate-logs`, and the PrefixRouter job `com.prefixrouter.server`.

## Approval expiry, `411c560e`

- **What:** an unanswered module approval expires after `APPROVAL_TTL_MS` (24 h). The host sweep drops the row and writes the outcome to the requesting agent. OneCLI credential rows are skipped (their own TTL); "reject with reason" holds have their own sweep.
- **Why:** a missed or lost card left the request, and the agent's workflow, pending forever.
- **Touches:** new `src/modules/approvals/expiry.ts` (+ test), `approvals/primitive.ts` (`APPROVAL_TTL_MS`, `expires_at` stamped in `requestApproval`), `approvals/index.ts` (exports `sweepExpiredApprovals`), `src/db/sessions.ts` (one query), `src/host-sweep.ts` (the `MODULE-HOOK:approvals-expiry-sweep` block).
- **Re-apply notes:** rows from before the TTL existed have no `expires_at` and age out from `created_at`.

## Agent-to-agent guard: wake once, then latch, `485b830f`, `3de64708`

- **What:** the a2a safety guards (repeat-loop, pair-message-limit) write a "stop and escalate" notice to the target. `blockDelivery` wakes the target on the **first** trip of an unbroken streak and stays silent for later trips in the same streak. The streak ends, re-arming the wake, when something other than the tripping source lands in the target's inbox.
- **Why:** waking on every trip handed the agent a new turn to fail the same way and re-trip the guard. On 2026-09-22 a broken `container.json` caused ~90 minutes of runaway spawns that exhausted the host heap and crash-looped the service.
- **Touches:** `src/modules/agent-to-agent/agent-route.ts` (`blockDelivery`, `alreadyNotifiedThisStreak`) and its tests. Test: `agent-route.test.ts` asserts no extra wake per trip for both guards.

## Shared day-token resolver, `bef29af5`

- **What:** `src/day-resolve.ts` is one function for the `day` argument of the notes/daily-note/journal shims: weekdays resolve ahead by default and back with `retrospective: true`, plus `DD` and `MM-DD` tokens; impossible dates are refused. Unique-prefix matching replaces an abbreviation list.
- **Why:** the `daily_note` shim looked ahead and the journal shim looked back, with separate resolvers.
- **Touches:** `src/day-resolve.ts`, `src/day-resolve.test.ts`; consumed by the instance repo's shims (`lumen-nanoclaw-instance/host-shims/_pool/`).

## Operator and debugging aids

- **Per-turn prompt dump (`2ac333bf`):** `container/agent-runner/src/poll-loop.ts` writes each turn's full prompt (wake context, briefing, recent turns, header, messages) to `/workspace/last-prompt.md`, replaced every turn, non-fatal on failure. Look at it with `docker exec` or in the group's workspace.
- **Last-context dump (`de0c385d`):** the Claude provider's Stop hook writes the last full context (header plus SDK transcript) to `logs/last-context/<group>/last-context.jsonl` through a host mount at `/workspace/last-context` (`src/container-runner.ts`, `container/agent-runner/src/providers/claude.ts`). In the same commit, idle-container reaps ("past absolute ceiling") log at INFO, and the non-zero-exit warning is skipped for those.
- **Briefing raw log (`24b2aeb3`, `briefing-raw` follow-up):** `src/modules/projected-sessions/compile-briefing.ts` appends each raw briefer output, timestamped, to `logs/briefing-raw/<group>.log`, one file per local day, keeping today plus the two previous days. The exception path no longer puts the failure note in the raw-response slot of the debug log.
- **SQLite error tagging (`42bf0cfc`):** `container/agent-runner/src/db/connection.ts` wraps the inbound/outbound handles so errors read `[db path op: sql]` instead of a bare "database disk image is malformed".
- **ISO log timestamps (`c0549a20`):** `src/log.ts` emits `new Date().toISOString()`; `ts()` is exported and pinned by `src/log.test.ts`. The `sqlite-corrupt-count-host` shim template's comment about undated lines was updated.
- **`x-agent-group` header (`ed810ee4`):** `src/container-runner.ts` sets `ANTHROPIC_CUSTOM_HEADERS` to `x-agent-group: <folder>` on every container (plus `x-session-id` for projected sessions). PrefixRouter uses it to tell agents apart (e.g. a per-agent last-request dump) and to key prompt-cache tracking. If upstream changes how env is built for the container, keep both header lines in one newline-joined value.

## Worktree hooks, `b32e3169`, `49b197fd`

- **What:** `.husky/post-checkout` runs inside a git worktree only (git-dir ≠ git-common-dir): recreates the instance-repo symlinks (`groups/`, `mcp-shims/`, `host-shims/`), runs a Node-22-pinned `pnpm install` when `node_modules` is missing, and calls `~/.claude/hooks/worktree-registry.sh sync` so every worktree lands in `~/.claude/worktrees.json`. `.husky/_/post-checkout` and `.husky/_/h` are tracked, because without them `core.hooksPath=.husky/_` points at an empty directory in a fresh worktree and no hooks run at all.
- **Re-apply notes:** the hook prepends `node@22` and `/opt/homebrew/bin` to `PATH`, because Claude Code spawns hooks with a minimal PATH and `pnpm` was otherwise "command not found". The registry call is best-effort.

## Documented elsewhere

| Feature | Where |
|---|---|
| Shim pool + per-group registry, host-shims and mcp-shims | [host-shims.md](host-shims.md), [mcp-shims.md](mcp-shims.md), [mcp-shims-inventory.md](mcp-shims-inventory.md), [instance-repo-split.md](instance-repo-split.md) |
| Vault memory pipeline, projected sessions | the `add-vault-memory-pipeline` and `add-projected-sessions` skills (and `recipe`); tuning history in [roadmap/warm-container-context-accumulation.md](roadmap/warm-container-context-accumulation.md) |
| Dispatcher / multi-agent delegation, `decision_description` | [dispatcher-agent.md](dispatcher-agent.md), [db-central.md](db-central.md) |
| Session sync | [session-sync-transport.md](session-sync-transport.md) |
| Follow-up timer | CLAUDE.md Key Files, `src/modules/followup/` |
| Built-in tool denials in containers | [agent-runner-details.md](agent-runner-details.md), [roadmap/per-agent-tool-control.md](roadmap/per-agent-tool-control.md) |
| Vision agent group, multi-file `send_file`/`assign_task` | [roadmap/visual-subagent.md](roadmap/visual-subagent.md) |
| Fresh-install / move to a new machine | [fresh-install-checklist.md](fresh-install-checklist.md), [fresh-install.md](fresh-install.md) |

## Skill freshness (checked 2026-11-03)

The `add-*` skills this fork wrote install by copying files out of branches on `origin` and applying a patch. A skill is only as current as its branch, and the branches were frozen at 2026-08-01 until this check.

| Skill | Status | How it was proven |
|---|---|---|
| `add-host-scripts` | **Current.** Branch `host-shim` refreshed (`313eb9c1`); installs the whole host-shim layer: pool + registry, mcp-shims manifest, all templates. `files.txt` + `shared-files.patch` live in the skill folder. | Applied literally on a clean checkout of the upstream merge-base `639577c3`: typecheck clean, 1349 host tests, 164 container tests, tree identical to the validated build. |
| `add-host-cron` | **Current.** Branch `host-cron` refreshed (`6feb8f97`). | Same, layered on the above: 1356 host tests. |
| `add-mcp-shim` | Current (guided workflow, no branch). | n/a |
| `add-mbif-vault` | Skill text only; not re-verified. | n/a |
| `add-projected-sessions`, `add-vault-memory-pipeline` | **Stale.** Their branches still hold the 2026-08-01 code. See below. | n/a |

Things worth knowing when re-applying:

- **Migrations are keyed on `name`**, not number; `version` is only an ordering hint. Upstream already uses 021–025 for unrelated migrations (`021-approval-question` etc.), so alias imports on collision and never rename an applied migration.
- **The host-shim container CLI on the branch has no session-sync overlay.** Trunk's `container/agent-runner/src/cli/host-shim.ts` (and `ncl.ts`) also handle the shelved `sync` transport and import `./sync-outbound-push.js`. The branch copy is trunk's file minus that overlay.
- **The memory system cannot be re-applied from skills alone yet.** Projected sessions, the vault transcript export and attachment captioning share edits in `container-runner.ts` (`wakeContainer`), `router.ts`, `session-manager.ts`, `formatter.ts` and `poll-loop.ts` with at least five other features (gated-task skip, stateless task markers, per-group env/blocked-host overrides, follow-up cancel, staged messages). `vault-transcript` imports `attachment-caption` and `projected-sessions/literal-tail`, and `attachment-caption/notify` imports `vault-transcript`. Until that is decomposed, re-apply them by `git cherry-pick` of the commits named in the sections above, or by diffing against `main`.
