---
name: recipe
description: This fork's applied-customizations ledger — every skill applied to this install, in apply order, with its source and why. Read before /update-nanoclaw or handing this fork to someone else; append to it whenever another skill's Apply steps say to.
---

# Recipe

Per `docs/skills-model.md`: "A fork is a recipe of skills... one 'recipe'
skill lists all your skills and how they fit together." This file is that
list for `lumen-nanoclaw`. It's what lets this fork be rebuilt from clean
upstream, or handed to someone else, without reconstructing "what did I
change" from memory or commit archaeology.

**This is a ledger, not a script.** Applying an entry means running that
skill's own Apply steps (or diffing its source branch) — this file just
records that it happened, in what order, and why. It is not itself
runnable end-to-end.

## How this file is maintained

- A skill that changes this fork's behavior appends one entry here as part
  of its own Apply steps (see the pattern in `add-projected-sessions/SKILL.md`'s
  own step for this) — creating this file with the header above if it
  doesn't exist yet.
- Idempotent: a skill re-applying itself skips appending if an entry for it
  already exists.
- A skill's REMOVE.md removes its own entry.
- Entries are in apply order — that's the order a clean rebuild replays them in.

## Applied skills

<!-- Each entry: - [skill-name](../skill-name/SKILL.md) — applied YYYY-MM-DD — one-line why -->
- [add-host-scripts](../add-host-scripts/SKILL.md) — applied 2026-08-01 — per-agent-group whitelisted host script execution; prerequisite for add-projected-sessions
- [add-host-cron](../add-host-cron/SKILL.md) — applied 2026-08-01 — schedule host-shim scripts on a cron, no container spawn; foundation for the vault memory pipeline's export/digest jobs
- [add-mbif-vault](../add-mbif-vault/SKILL.md) — applied 2026-08-01 — MBIF vault tooling underlying the memory pipeline's export/digest/librarian jobs
- [add-vault-memory-pipeline](../add-vault-memory-pipeline/SKILL.md) — applied 2026-08-01, patched 2026-08-06 — live per-turn transcript export + scheduled daily/weekly/monthly digest generation via MBIF's librarian; patch gated live export behind an explicit `ncl vault-transcripts enable` per group (migration 030) instead of firing unconditionally for every group including `create_agent` subagents — see SKILL.md step 5b
- [add-projected-sessions](../add-projected-sessions/SKILL.md) — applied 2026-08-01 — self-contained briefing-agent module; interleaves briefing history, real names, local timestamps into projected session context
- [add-telegram](../add-telegram/SKILL.md) — applied 2026-08-02 — Telegram channel adapter via Chat SDK
- [add-mcp-shim](../add-mcp-shim/SKILL.md) — applied 2026-08-04 — mcp-shims v1: auto-register whitelisted host scripts as real MCP tools, guided per-tool authoring workflow
