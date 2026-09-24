# Calendar event notes: screen the Teams signature, protect hand-written notes

Raised 2026-09-23 (David), with `07-Daily/Calendar/2026/09/22/a-team-standup-04000000.md` as the example.
Ownership: the note writer is `scripts/calendar-sync/sync.js` in the vault, maintained by the Obsidian
project's Claude (memory `vault-calendar-sync-ownership`), so this is a hand-off spec, nothing built here. Do it
together with [calendar-day-index-links.md](calendar-day-index-links.md): same writer, same backfill pass.

## Status 2026-09-23

- **Backfill done** on David's instruction, by `scripts/calendar-note-body-backfill.mjs` (dry run by default,
  `--apply` writes, idempotent, `--only <substring>` shows one note). Applied to all 150 event notes: `**When:**`
  line removed, Teams signature screened to join link / Meeting ID / Passcode / Phone Conference ID (29 notes
  used the main layout; the other layouts were spot-checked), description wrapped in a `> ` quote block ending
  in a `^event-desc` line. Verified: a second run skips all 150, zero notes still have a `**When:**` line or Teams
  boilerplate, Routine's calendar tools still read the notes. Backup of the whole Calendar folder before applying:
  `~/lumen-calendar-backup-20260923.tgz`. `day_index` was **not** part of this pass.
- **Routine's note writers** no longer emit `**When:**` (live-verified).
- **NOT done, and it matters: `sync.js` still writes the old layout** (`**When:**` line, raw description, whole-body
  overwrite). Until the vault project's Claude changes it, an upstream edit to an event (a Teams description or time
  change) makes sync re-render that one note in the old format, dropping the block and anything typed below it.
  Do not rely on typed notes below `^event-desc` until that lands. The four `sync.js` changes are listed below.
- The dial-in number (`+1 615-924-8724,,ID#`) and `Video Conference ID` were dropped, as specified. One forwarded
  email thread (`comptroller-trams-pre-assessment-info...`) contains a plain underscore line but no Teams
  content, so only its quoting changed.

## Three requests, one mechanism

1. **Screen the Teams signature.** Keep only the join link, Meeting ID, Passcode and Phone Conference ID.
2. **Drop the `**When:**` line** from the template and the sync process (David, 2026-09-23): `local_start` and
   `local_end` in the frontmatter already carry it, and nothing reads the line (checked: it only has writers,
   `sync.js` ~lines 140-141 and Routine's two writers). **Routine's writers are done** (`vault-events.ts`,
   verified live on a scratch note); `sync.js` and the backfill are the vault project's.
3. **Put the meeting's own text in a single `> ` quote block with a block ID, and never touch anything outside it.**
   Everything David or an agent types below the block survives a re-sync.

David's reasoning for (2): notes typed into an event note must not be overwritten when the upstream Teams
description changes. This works, and it is needed regardless of the Teams cleanup: today `sync.js` rewrites the
**whole note** whenever the event hash changes (`writeFileSync(notePath, fm + body)`, ~line 145; the
unchanged-hash skip is at ~line 92), so any typed note would be lost on the first upstream edit.

## Target layout

```markdown
---
(frontmatter as today, plus day_index)
---
# A-Team Standup

> [Join the meeting](https://teams.microsoft.com/l/meetup-join/...)
> Meeting ID: 278 106 922 700
> Passcode: xTPgFd
> Phone Conference ID: 111 258 424#

^event-desc

(everything from here down belongs to the reader: typed notes, agent notes, never touched by sync)
```

- The block ID goes on its own line after one blank line (an Obsidian quote-block ID), same convention as the
  `^daily-notes` block in the daily notes ([routine-daily-notes.md](routine-daily-notes.md), 2026-09-23 addendum).
- **Ownership zones on every re-sync:** frontmatter keys sync owns are updated in place (keys others add, such
  as `conflicts-with`, are kept); the title is regenerated; the block up to and including
  the `^event-desc` line is regenerated; **everything after the `^event-desc` line is preserved byte-for-byte**.
  Nothing a person types may live inside the quote block, since sync owns it.
- If the marker is missing on an existing note, keep the whole existing body and insert a new block after the
  title rather than overwriting.
- The whole upstream description goes in the block, not just Teams notes: an organizer's agenda text before
  or after the signature is kept. Blank lines inside become bare `>` lines. Convert `text<URL>` to
  `[text](URL)`.

## Screening rule (Teams)

Found in **43 of the 77** `kind: "work"` notes. The signature sits between two 80-underscore rule lines.
Variants seen in the vault: `Phone Conference ID` and `Phone conference ID` (case differs); a `Dial in by
phone` layout; a `Join with a video conferencing device` block with a VTC address and `Video Conference ID`; a
newer one-line `Join: https://teams.microsoft.com/meet/...?p=...` form; and `Meeting ID` values of 12 or more
digits.

- Detect a region as: text between `^_{20,}$` lines that contains a `teams.microsoft.com` link. Leave any other
  underscore-fenced text untouched.
- Inside it keep, in this order: the join link (from `Click here to join the meeting<URL>` or `Join: URL`, rendered
  `[Join the meeting](URL)`), `Meeting ID: ...`, `Passcode: ...`, `Phone Conference ID: ...` (match label
  case-insensitively). Drop the rules themselves and everything else: "Microsoft Teams meeting", "Join on your
  computer...", `Download Teams`, `Or call in`, the `tel:` line, `Find a local number | Reset PIN`, `Learn More |
  Meeting options`, the organizer footer, `Need help?`, the VTC block.
- Keep the original join URL exactly as it appears, tracking parameters and all (a truncated URL would break it).
- **Open question for David:** the `tel:` line (`+1 615-924-8724,,111258424#` United States, Nashville)
  is the dial-in number; the Phone Conference ID is only useful alongside it. This spec drops it as asked; say
  so if you want it kept. Same for `Video Conference ID` (VTC rooms).

## Re-render and backfill

- `event_hash` is computed from the raw event, so existing notes will not be re-rendered by the change alone
  (unchanged hash means skipped). Add a format version to the hash inputs, or run a one-off migration; the
  migration is needed for the 150 existing notes anyway.
- **Backfill** (once, after the writer change lands, idempotent, dry-run first on a copy): for each event note,
  remove the `**When:**` line, screen the description as above, wrap it in the `^event-desc` block, and keep any content that is not sync's
  template output below the block instead of dropping it. Report notes it could not classify rather than guessing.
  Verify: every event note has exactly one `^event-desc` line, and no note still contains `Download Teams`, an
  80-underscore rule, or a `**When:**` line.
- Check `refile.js` too: if it rewrites the body on a timezone re-file, it must respect the same ownership zones.

## Follow-on work in this repo, once the marker exists

- `calendar_note_append` (Routine) appends at the end of the body. It must append **below** the `^event-desc`
  line, with a blank line first, so the text can never be absorbed into the quote block.
- `personal_edit`'s `rewriteEventNote` overwrites the whole body of routine-owned notes, so it would destroy
  typed notes the same way. It should rewrite only the frontmatter, title and the block, and `personal_add`
  should put its description in the same block layout. Related existing bug (seen 2026-09-23): `personal_edit`
  takes `location`/`description` only from that call's arguments, so an edit that omits them silently drops both
  from the note. Fixing the rewrite to preserve the body fixes this too.
