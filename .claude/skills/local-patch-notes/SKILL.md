---
name: local-patch-notes
description: Maintain docs/local-patch-notes.md and docs/local-patch-notes/<date>.md — a per-calendar-day history of local (non-upstream) changes to this NanoClaw install, merged across both lumen-nanoclaw and lumen-nanoclaw-instance. Use when asked to update/backfill the local patch notes, or when the phrase "local patch notes" comes up.
---

# Local Patch Notes

Keeps `docs/local-patch-notes.md` (a thin chronological index, oldest day first) and one
file per day under `docs/local-patch-notes/<YYYY-MM-DD>.md` current — a history of what
changed in *this specific install*, separate from upstream NanoClaw's own changes, for an
administrator who manages this install day to day but wasn't present for the work.

## Two repos, one merged history

Two repositories carry "our" changes, and every day's entry merges both into one set of
bullets — never split into a per-repo section:

- **`lumen-nanoclaw`** (this checkout). Has `origin` (this fork) and `upstream` (the real
  NanoClaw project). "Our" commits are on `origin`'s `main` and NOT in `upstream/main`:
  ```
  git fetch upstream --quiet
  git log --pretty=format:'%H|%ad|%s' --date=format:'%Y-%m-%d' main ^upstream/main
  ```
  Upstream's own commits never get reported here.
- **`~/Projects/lumen-nanoclaw-instance`** (private; holds `groups/`, `mcp-shims/`,
  `host-shims/`, symlinked into `lumen-nanoclaw`). No upstream concept — every commit is
  ours by definition:
  ```
  cd ~/Projects/lumen-nanoclaw-instance
  git log --pretty=format:'%H|%ad|%s' --date=format:'%Y-%m-%d'
  ```
  **This repo's commit stream is dominated by automated churn** — memory-index state, pid
  files, injection logs, token-usage logs. Most commit *subjects* mention this churn even
  when they also carry one real change in a trailing clause (e.g. "...and routine agent
  instructions", "...and daily_note MCP shims"). A keyword/prefix filter on the subject
  line is not enough — read the full commit body (`git log -1 --format='%B' <hash>`) and
  judge each one. When a commit's purpose genuinely isn't clear from message + diff, say
  so in your report rather than guessing at a tidy description.

## Full backfill vs. incremental catch-up

- **No existing index, or explicitly asked to redo history**: full backfill — walk every
  calendar day since the beginning of local history in both repos.
- **Index already exists**: incremental — read `docs/local-patch-notes.md`'s last dated
  entry, only look at commits *after* that date in both repos. Don't touch, renumber, or
  rewrite any earlier entry.

If the caller doesn't say which, default to incremental against whatever index already
exists.

## Filtering and tone rules

- **Same-day made-and-reversed changes net to nothing** — don't report either the change
  or the revert. A change that was *refined, extended, or partially walked back* the same
  day (not a full revert) gets reported as its end-of-day state, not narrated as
  back-and-forth.
- **No commit hashes, no file:line references, no developer-changelog implementation
  detail.** No end-user marketing tone either.
- **Audience**: a technical administrator who manages this install day to day (restarts
  services, manages agent groups, reads logs) — assume they know NanoClaw's own
  vocabulary (agent groups, MCP shims, wirings, `ncl`, wake scripts, etc.) but were not
  present for the work.
- **Merge, don't enumerate**: multiple commits about the same feature/thread collapse
  into one bullet describing where that thread ended up by end of day — not one bullet
  per commit. Distinct, unrelated same-day changes get separate short bullets (1-3
  sentences each) rather than being forced into one sentence.
- **Omit days with nothing reportable** (pure noise, or a full same-day revert-to-nothing)
  from the index entirely. Never write a filler entry.
- **The index stays thin**: one line per day, one broad orienting sentence, no per-item
  essays — detail lives only in that day's own file.

## Output

- `docs/local-patch-notes.md` — index, chronological, oldest first. New/updated lines
  only; don't touch entries outside the period you're covering.
- `docs/local-patch-notes/<YYYY-MM-DD>.md` — one file per reportable day, short bullets.

## What to report back when done

- Which days were added or updated, and which were deliberately omitted (and why).
- Every judgment call worth a second look: a same-day-revert call, and any instance-repo
  commit whose noise-vs-signal call was close. Don't silently decide these and leave the
  user to discover the call only by reading the output closely.

## Constraints

- Don't commit the result — leave it for the user to review, unless explicitly told
  otherwise.
- Don't fabricate a plausible-sounding change for a day where the actual commit content
  doesn't clearly support it.

## Delegating this to a subagent

**This section is for whoever first invokes this skill in an interactive session,
deciding how to route the work — it is not an instruction to whichever agent ends up
actually doing the work.** If you are already the agent tasked with producing the patch
notes (you were dispatched specifically for this, or you're executing this skill's steps
directly), do the work yourself: read the commits, apply the rules above, write the
files. Do not spawn a further subagent to do it "for" you — there is no reason for this
work to run more than one layer deep, and doing so just burns tokens re-deriving the same
context with nothing gained.

For the invoker: this is commit-archaeology work across two repos and can involve
reading many commit bodies — reasonable to hand to a single subagent (fresh context, e.g.
a `general-purpose` or `sonnet`-model agent) rather than doing it inline yourself. When
you do, give that subagent this file's content directly (it has no memory of this
conversation) plus the specific date range to cover, rather than making it re-derive the
rules from scratch. One layer of delegation, never more.
