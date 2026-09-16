# Host Shims

Whitelisted host-side scripts an agent group can invoke via the Bash tool (`src/modules/host-shim/exec.ts`'s `execHostShim`). Each group gets its own `host-shims/<group>/` directory, seeded once from `src/host-shim-templates/` by `group-init.ts`'s `initGroupFilesystem` and never overwritten again — a group's own edits (chiefly `VAULT_PATH`) survive every future spawn/restart. That also means trunk template fixes don't reach an already-seeded group automatically: fold generic fixes into the template, then manually re-merge into any live copy that needs them. See [docs/roadmap/host-shim-templates-drift.md](roadmap/host-shim-templates-drift.md) for a live instance of this exact gap (fixes made to `lumen-dmj`'s copies on 2026-09-16 not yet ported back to the trunk template).

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

## Scheduled-task gate scripts calling a host-shim

A task's `--script` gate (`ncl tasks create --script`, see `src/cli/resources/tasks.ts`) always runs *inside* the agent container, never on the host — including on a Linux container backing a macOS install. If a gate genuinely needs a host-only capability (driving a host GUI app via `osascript`/`open -a`, reading something only the host filesystem/OS exposes, etc.), write it as a host-shim and have the task's script call `host-shim <leaf-name>` instead of running the host-only commands directly. Getting this wrong doesn't fail loudly: the container-side command errors (or silently no-ops), but the script can still emit `{"wakeAgent": false}` unconditionally at the end and the task keeps reporting success while never doing the thing it was scheduled for.

Not a trunk template (too install-specific to generalize), but the pattern: a group's `omnisearch-reindex-host`-style task originally ran `osascript -e 'quit app "Obsidian"'` / `open -a Obsidian` straight in its `--script`, which always failed inside the container (`xdg-open: unexpected option '-a'`) while still reporting `wakeAgent: false` success — silently never restarting anything for weeks. Fixed by moving the actual restart + health-check into a `restart-obsidian-host` host-shim and having the task's script call `host-shim restart-obsidian` (leaf name only — the host-shim CLI appends `-host` itself) and branch `wakeAgent` on that call's exit code instead.

## Conventions shared across this family

- **Subagent naming**: `briefer` (compile briefings), `digester` (daily summary), `librarian` (rollups), `seeker` (read-only Q&A), `sorter` (inbox filing) — a vault adopting this family defines all five under `.claude/agents/`.
- **Dispatch mode**: `briefing-host` uses `--system-prompt-file` (not `--agent`) because it supports routing through a spoofed-key local model proxy, and background-agent dispatch (`--agent`) rejects spoofed keys outright — see the comment block in that template. `lumen-dmj`'s live `recall-host` copy switched to the same `--system-prompt-file` pattern on 2026-09-16 for the same reason (routing off a personal Anthropic subscription onto PrefixRouter); the trunk template hasn't been updated to match yet (see `docs/roadmap/host-shim-templates-drift.md`) and still uses plain `--agent seeker`. `inbox-triage-host` remains on `--agent` against the real Anthropic API, where the proxy restriction doesn't apply unless you choose to route it too.
- **`--system-prompt-file` mode needs its own `--disallowedTools` write-access denylist — and `Bash` is the one that's easy to forget.** Selecting an agent's persona via `--agent <name>` also enforces that agent's own `tools:` frontmatter restriction; folding the same persona into `--system-prompt-file` does not carry that restriction over — `claude` never reads the stripped frontmatter, so `--permission-mode bypassPermissions` alone would grant full read/write access regardless of what the source agent declares. The correct denylist, already proven in `briefing-host`'s band/focus-updater dispatch: `--disallowedTools Write,Edit,NotebookEdit,Task,Agent,Bash`. Caught twice on 2026-09-16: first as a missing denylist entirely (both `briefing-host`'s main dispatch and the first draft of `recall-host`'s conversion), then again after adding `Write,Edit,NotebookEdit,Task,Agent` without `Bash` — verified-blocked only for a direct "use the Write tool" prompt, then a plain `echo test > file` via Bash sailed straight through on the very next live test. **Verify this kind of denylist by asking the model to write a file "using whatever tool is available," not by naming a specific tool** — naming one only tests that one path.
- **Persona-file reads should tolerate malformed UTF-8.** A vault's own `.claude/agents/*.md` / `.claude/skills/*/SKILL.md` files aren't guaranteed clean — a corrupted byte in one (found in a multilingual trigger list, 2026-09-16) will crash a strict `open(..., encoding="utf-8")` Python read. Any shim folding a persona file into a system prompt should open it with `errors="replace"`.
- **Output sanitization**: any shim using `--output-format json` pipes through the same control-byte-escaping Python one-liner (see `briefing-host`) — `claude`'s JSON output occasionally emits raw unescaped control bytes inside string values on long replies.
- **`--output-format json` shape is a moving target across CLI versions**: as of `claude` 2.1.261 it emits a JSON *array* of streamed events (`system`/`assistant`/`result`/...), not the single final-result object older versions returned. A shim written against the old shape (`jq -r '.result'` or `json.load(...)["result"]`) fails — usually silently, since a `try/except: exit 0` around the extraction (see `briefing-host`) makes a shape mismatch look like "no output" rather than an error. `recall-host` and `briefing-host` both broke this way on 2026-09-16 and were fixed by unwrapping to `[.[] | select(.type == "result")] | last` before any further extraction, with a passthrough fallback so an older/reverted CLI's single-object shape still works unchanged. Any new shim using `--output-format json` should do the same unwrap up front rather than assume either shape.
- **Token logging**: `briefing-host` and `recall-host` each append a TSV row per call to their own `.{name}-tokens.log` next to the script, for tuning prompt/length changes against actual cost.
- **`00-Inbox/` as the write surface**: `remember-host`, `recall-host` (`detail=note`), and `sorter`'s output all land in `00-Inbox/` first rather than writing directly into the vault's structured folders — a single triage point instead of every writer needing its own filing logic.
