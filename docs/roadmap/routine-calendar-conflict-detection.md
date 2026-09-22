# `routine` — detect and resolve Routine-added vs. authoritative calendar conflicts

Raised 2026-09-22, right after [routine-vault-calendar.md]'s replacement of the ICS-feed
shims shipped (that item's own file has since been deleted — see `docs/roadmap.md`'s
"Closed 2026-09-22" entry for what it covered). Design finalized 2026-09-22 across two
rounds of review; not built yet.

## The problem

`routine` can add its own events to the vault's local calendar copy (`calendar_personal_add`,
`kind: "routine"` frontmatter so the sync pipeline's own staleness sweep never touches
them). Nothing stops the *same* event from also landing on the real upstream calendar
independently (David adds it directly in Google Calendar, or a second integration does) —
sync.js then pulls it in as its own `kind: "personal"` (or eventually `"work"`) note,
landing in the same day folder as a note routine already created for what might be the
identical event. Left alone, both records exist forever with no reconciliation.

## Decided (2026-09-22, final)

1. **Trigger — chained after the vault's own hourly sync, not a new independent schedule.**
   David's revised call: doing this once a day (folded into the morning digest, the
   original plan) is too infrequent — the vault's hourly `sync.js --days=1` cron is what
   actually introduces new authoritative events, so that's when a conflict can first
   exist. Rather than give the conflict-check its own independent cron schedule ("multiple
   tasks stepping on each other's toes seems like a terrible idea" — David's words from the
   original trigger discussion, still the operative constraint), the vault's own hourly
   crontab line now chains straight into it:

   ```
   0 * * * * cd .../scripts/calendar-sync && node sync.js --days=1 >> logs/sync-1d.log 2>&1 \
     && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /Users/lumen/.local/bin/ncl tasks run \
        --id calendar-conflict-check-8b4f --group ag-32059f15-f18a-4505-9d2e-e62b55131587 \
        >> .../scripts/calendar-sync/logs/conflict-check-trigger.log 2>&1
   ```

   `ncl tasks run` fires an existing task series immediately without touching its own
   schedule (queues an extra run, doesn't consume/advance the series) — so the check only
   ever actually runs right after a sync, on real new data, not on an independent clock
   that could overlap with anything else.

   **Task series**: `calendar-conflict-check-8b4f` (Routine, `ag-32059f15-...`), created
   `--stateless` (each run is self-contained) with a sparse `0 13 * * *` (1pm daily)
   fallback recurrence — a safety net only, in case the cron chain ever silently breaks;
   the real trigger is always the chained `ncl tasks run` call. It's a pure-prompt task
   (no `--script` gate), so the scan is a new **agent-facing mcp-shim**,
   `calendar_conflict_scan`, called directly by the agent like `calendar_personal_today`
   already is — not a host-shim (the task-gate/host-shim pattern in `docs/host-shims.md`
   only applies to `--script`-gated tasks, which this isn't).

   **Cron-env gotcha, caught and fixed before wiring**: `ncl` execs `pnpm exec tsx`
   internally, and cron's minimal default `PATH` doesn't include `/opt/homebrew/bin`
   (where this install's `pnpm`/`node` live) — confirmed by reproducing the exact failure
   with `env -i PATH=/usr/bin:/bin ncl ...` (`exec: pnpm: not found`) before touching the
   real crontab, then confirming the fix (`PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
   prefixed on the chained call) resolves it. This is the same class of gotcha
   `docs/host-shims.md` already documents for host-shims under launchd — cron and launchd
   both start from a stripped environment.

   **Crontab backup taken before editing**: `~/crontab-backup-20260922-145428.txt` — full
   pre-change crontab, for rollback (`crontab ~/crontab-backup-20260922-145428.txt`).
2. **Match heuristic — confirmed as originally proposed.** `calendar_conflict_scan`
   surfaces cheap *candidates* only: same local day (group's own timezone), one note
   `kind: "routine"`, another note in the same day folder with a different `kind`, and
   their time ranges either overlap or start within 30 minutes of each other (tunable
   constant). It also skips any routine note whose `conflicts-with` list (see #4) already
   names that specific other note — the actual "is this really the same event" judgment
   is routine's own call once shown both full records, never the scan's.
3. **`_index.md` dataview query — done today, not deferred.** Two changes, both live:
   - Excludes `status: "deleted"` alongside the existing `status: "cancelled"` exclusion
     (needed once `calendar_personal_delete`, below, exists).
   - Switched from `LIST` (shows bare filenames) to `TABLE title as "Event",
     choice(all_day, "(all day)", start_wall + " – " + end_wall) as "Time"` — shows the
     event's actual title and time range instead of its slug-plus-id filename.
   - Updated in both places that generate this query: the vault's own
     `scripts/calendar-sync/refile.js` (`indexContent`, used by `sync.js` for every new
     day folder) and NanoClaw's `mcp-shims/routine/daily_note/shared.ts`
     (`templateContent`, the fallback used when `daily_note_read`/`append` needs to create
     a day's index before sync.js has reached that day) — the two must stay byte-identical
     since either can create a given day's `_index.md` first.
   - **Backfilled all 95 pre-existing `_index.md` files** under `07-Daily/Calendar/` with
     the new query text (a literal, idempotent find-and-replace on the old query string).
     Left the 10 `_series/` master notes alone — different template, out of scope.
   - Also updated `vault-events.ts`'s own `readDayEvents` filter (the JS side, used by
     `calendar_personal_today/tomorrow/week`) to skip `status: "deleted"` alongside
     `"cancelled"` — independent of the dataview query above, since that only affects
     Obsidian's own native view, not NanoClaw's tool output.
4. **`calendar_personal_delete` — soft delete only, never destructive.** David: "I don't
   *delete* data irrevocably if I can help it." Input `{path, reason}` (`reason`
   required). Routine-owned notes only (same ownership refusal as `calendar_personal_edit`).
   Behavior: `status: "deleted"`, filename renamed to `DELETED-<original filename>` (via
   `obsidian-cli move`), and `reason` appended to the note's body under a `**Deleted:**`
   line — never overwrites existing content.
5. **`conflicts-with` is a list, not a single wikilink.** David: "Potentially many, so
   let's make it a list of things it might conflict with. I can try to resolve them
   manually if necessary." Frontmatter becomes `conflicts-with: ["[[note-a]]", "[[note-b]]"]`
   — the scan appends a new entry rather than overwriting, and never re-flags a pair
   already in the list. Set via `obsidian-cli property:set ... type=list` at the moment a
   candidate is surfaced (not at resolution) — matches "never re-wake on the same pair"
   even if the human side of escalation stalls. Accepted tradeoff, unchanged from the
   first design pass: a candidate that's flagged but never actually resolved won't get a
   second automatic nudge on its own.
6. **Generalize past `kind: "personal"` now**, confirmed. The scan and both new tools key
   off "any `kind` other than `routine`" vs. `"routine"`, never a hardcoded `"personal"`
   string — ready for the work calendar (`kind: "work"`, not live yet) without revisiting.

## Still needed, not yet built: merge-append tool

Confirming a duplicate means merging routine's own notes into the *authoritative* note's
body before deleting routine's copy. `calendar_personal_edit` can't be reused for this — it
deliberately refuses to touch anything not owned by routine, and that refusal stays as-is.
A separate tool is needed:

- **`calendar_note_append`** (mcp-shim, agent-facing): appends free text to the *body* of
  any event note by path, routine-owned or not, touching frontmatter not at all. Safe
  against sync.js because sync.js's own upsert patches specific frontmatter fields in
  place and never rewrites the body wholesale (confirmed by reading `sync.js` during the
  original vault-calendar investigation).

## Escalation flow (uses existing infra, no new mechanism)

When `calendar-conflict-check-8b4f` fires and finds candidates, it shows routine both records'
full frontmatter + body and routine decides:
- **Confident duplicate** → `calendar_note_append` routine's notes onto the authoritative
  note, then `calendar_personal_delete` its own note with a `reason` explaining the merge.
- **Not confident** → message Lumen via the existing live `routine` → `lumen-dmj` a2a route
  with both records, asking for a second opinion.
- **Lumen also unsure** → she asks David directly via her own existing approval/DM path.
  No new mechanism needed for this hop — just routine's (and Lumen's) prompt/persona
  needs to describe this policy in prose.

## Tool/asset inventory for the build

Still to build (mcp-shims — none exist yet):
- `calendar_conflict_scan` (agent-facing) — the actual match-heuristic logic (#2 above),
  reading/comparing notes across the day folder and appending to `conflicts-with`.
- `calendar_personal_delete` (soft delete, routine-owned only, per #4 above).
- `calendar_note_append` (body-only append, any event note, per the merge-append section
  above).

Done 2026-09-22:
- `_index.md` dataview query (both generators + 95-file backfill) — excludes `"deleted"`,
  shows title + time range instead of filename.
- `vault-events.ts`'s `readDayEvents` — skips `status: "deleted"` alongside `"cancelled"`.
- **Trigger wired end-to-end**, ahead of the tools that will actually do the work:
  task series `calendar-conflict-check-8b4f` created (Routine), hourly-sync crontab line
  chains `ncl tasks run` into it, cron-env `PATH` gotcha reproduced and fixed, crontab
  backed up first. Fired once manually to confirm the chain itself works — that test run
  will fail/no-op today since `calendar_conflict_scan` doesn't exist yet; that's expected,
  not a problem with the trigger.

Still to change:
- routine's persona/prompt — describe the escalation policy (confident → merge+delete;
  unsure → ask Lumen; Lumen unsure → ask David) and the `conflicts-with` list convention,
  beyond what's already in `calendar-conflict-check-8b4f`'s own task prompt.

## Status: trigger wired live, three mcp-shims still to build

Design finalized across two review rounds, then the trigger itself (task series +
crontab chain + PATH fix) built and confirmed live, all 2026-09-22. Next: build
`calendar_conflict_scan`, `calendar_personal_delete`, `calendar_note_append`.
