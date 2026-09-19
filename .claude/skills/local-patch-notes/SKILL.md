---
name: local-patch-notes
description: Maintain docs/local-patch-notes.md and docs/local-patch-notes/<date>.md — a per-calendar-day history of local (non-upstream) changes to this NanoClaw install, merged across both lumen-nanoclaw and lumen-nanoclaw-instance. Use when asked to update/backfill the local patch notes, or when the phrase "local patch notes" comes up.
---

# Local Patch Notes

Dispatch a single Sonnet-tier subagent (fresh context — it has no memory of this
conversation) and hand it the complete, verbatim contents of `WORKER.md` in this skill's
folder as its instructions, plus the specific date range or scope you want covered (e.g.
"incremental catch-up from the index's last entry" or "full backfill from the beginning").

Do not read `WORKER.md` yourself and perform the work directly in this conversation —
always route it through that one subagent. `WORKER.md` is written for the subagent, not
for you: it opens by telling the executing agent it is the one doing the work and must
not delegate further. Keeping the "how to invoke this" instructions (this file) and "how
to actually do it" instructions (`WORKER.md`) in separate files is deliberate — it means
an agent handed the worker file directly only ever sees the worker's own frame, never
this dispatch instruction, so there's no path back into the loop.
