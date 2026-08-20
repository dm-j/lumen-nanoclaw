# Host Shims

Whitelisted host-side scripts an agent group can invoke via the Bash tool (`src/modules/host-shim/exec.ts`'s `execHostShim`). Each group gets its own `host-shims/<group>/` directory, seeded once from `src/host-shim-templates/` by `group-init.ts`'s `initGroupFilesystem` and never overwritten again — a group's own edits (chiefly `VAULT_PATH`) survive every future spawn/restart. That also means trunk template fixes don't reach an already-seeded group automatically; see [Reconcile host-shim trunk templates addendum, 2026-08-15] for the mechanism (fold generic fixes into the template, manually re-merge into any live copy that needs them).

This is not an exhaustive list of every possible host-shim — it documents the vault-integration family that ships as templates. All of them originated as `lumen-dmj`-only scripts; the ones marked "added 2026-08-15" below were folded into the trunk template that day after auditing for drift.

## Vault memory pipeline

Four shims form the write/read path between chat turns and an Obsidian vault, feeding the projected-sessions briefing system (`docs/session-sync-transport.md` §1, `docs/architecture.md`).

| Shim | Trunk template? | Calling contract | Purpose |
|---|---|---|---|
| `transcript-append-host` | Yes | `<speaker> <utc-iso-timestamp> <text> [image-path]` | Appends one delivered/inbound chat turn to the vault's `07-Daily/Transcripts-readonly/YYYY/MM/DD.md`, creating the file on first turn of the day. The optional 4th arg embeds a resized image attachment. Called by `src/modules/vault-transcript/transcript.ts` once per turn when the group has vault-transcript enabled. |
| `digest-daily-host` | Yes | `[YYYY-MM-DD]` (default: yesterday, in vault's own timezone) | Shells to a `digester` subagent to summarize a day's transcript into `07-Daily/Digests-readonly/`. Idempotent via its own checkpoint post-it. Scheduled by `host-cron`. |
| `digest-rollup-host` | Yes | none | Shells to a `librarian` subagent to roll daily digests up into weekly/monthly summaries. Idempotent (fills in only missing subheaders/sections). Scheduled by `host-cron`. |
| `briefing-host` | Yes | `<prev-briefing-file> <new-batch-file>` (positional args, per `compile-briefing.ts`) | The projected-sessions compiler step: shells to a `briefer` subagent to produce (or update) the rolling briefing a projected session's responder reads instead of resuming a transcript. See `docs/session-sync-transport.md` and `docs/roadmap/warm-container-context-accumulation.md` for the surrounding design. `lumen-dmj`'s live copy adds a three-band working-memory system on top (see below) — deliberately not in the trunk template, since it assumes vault state the template doesn't provide. |

## Ad-hoc recall/remember

Two shims back MCP tools an agent can call mid-conversation to query or write to the vault directly, independent of the briefing pipeline.

| Shim | Trunk template? | Calling contract | Purpose |
|---|---|---|---|
| `recall-host` | Yes (added 2026-08-15) | `<json>`: `{"query", "ask_as", "detail": "sentence\|paragraph\|bullets\|note", "research"}` | Vault question-answering. Shells to a read-only `seeker` subagent (Read/Glob/Grep/WebSearch/WebFetch, no Write), then this script — not the subagent — performs the file write for `detail=note` into `00-Inbox/`. |
| `remember-host` | Yes (added 2026-08-15) | `<json>`: `{"title", "content", "source", "confidence", ...extra}` | Ad-hoc fact capture — writes a `type: fact` note straight into `00-Inbox/` (no subagent call; the calling agent already composed the content). |

## Inbox processing

| Shim | Trunk template? | Calling contract | Purpose |
|---|---|---|---|
| `inbox-triage-host` | Yes (added 2026-08-15) | none | Counts `00-Inbox/`; if non-empty, backgrounds a `sorter` subagent to file each item and returns immediately (the only async shim in this family — the others block on a subagent result). |

## Diagnostics (not vault-specific)

| Shim | Trunk template? | Calling contract | Purpose |
|---|---|---|---|
| `sqlite-corrupt-count-host` | Yes (added 2026-08-15) | none | Counts `DB_RETRY_EXHAUSTED` lines in `logs/nanoclaw.error.log` since the last check (byte-offset checkpoint, not timestamp-parsed). Backs an "alert watch" task for the recurring macOS VirtioFS bind-mount corruption issue that `docs/session-sync-transport.md` is the real fix for. Reads the host's own error log, not anything under `VAULT_PATH`. |

## Conventions shared across this family

- **Subagent naming**: `briefer` (compile briefings), `digester` (daily summary), `librarian` (rollups), `seeker` (read-only Q&A), `sorter` (inbox filing) — a vault adopting this family defines all five under `.claude/agents/`.
- **Dispatch mode**: `briefing-host` uses `--system-prompt-file` (not `--agent`) because it supports routing through a spoofed-key local model proxy, and background-agent dispatch (`--agent`) rejects spoofed keys outright — see the comment block in that template. The others use plain `--agent <name>` against the real Anthropic API, where that restriction doesn't apply. If you route `recall-host`/`inbox-triage-host` through a proxy too, switch them to the same `--system-prompt-file` pattern.
- **Output sanitization**: any shim using `--output-format json` pipes through the same control-byte-escaping Python one-liner (see `briefing-host`) — `claude`'s JSON output occasionally emits raw unescaped control bytes inside string values on long replies.
- **Token logging**: `briefing-host` and `recall-host` each append a TSV row per call to their own `.{name}-tokens.log` next to the script, for tuning prompt/length changes against actual cost.
- **`00-Inbox/` as the write surface**: `remember-host`, `recall-host` (`detail=note`), and `sorter`'s output all land in `00-Inbox/` first rather than writing directly into the vault's structured folders — a single triage point instead of every writer needing its own filing logic.
