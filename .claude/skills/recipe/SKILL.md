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
