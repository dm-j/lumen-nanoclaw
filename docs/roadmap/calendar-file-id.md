# Calendar event notes: a real per-note `lumen_file_id`

Agreed 2026-09-26 (David). **Not built.** The migration touches `sync.js`, which the vault project's Claude owns, so it is
recorded here as a decision plus a self-contained brief for that session (paste it there).

## Why

Calendar event notes are named `<slug>-<uid8>[-<recurrenceId>].md`, where `uid8` is the first 8 characters of the
calendar UID (`sync.js`, `occurrenceNotePath`). That was fine with one Google calendar. It is not unique now:

- **Exchange/Outlook UIDs all begin `040000008200E00074C5B7101A82E008...`**, so every work event gets `uid8 = 04000000`
  (16 different work titles share it today; 19 filenames repeat across day folders because a recurring series reuses one
  name per day).
- **Same-title collision (real, latent):** two meetings with the same title on the same day compute the same path.
  `writeOccurrence` looks the note up by that computed path, so the second overwrites the first (different
  `event_hash` means rewrite). One meeting silently disappears from the mirror.
- The calendar tools need a short, stable way to name one event. `get_calendar` currently returns `id` = the filename
  minus `.md` (routine-side, commit `1ece6842`), which is unique within a day folder only because the filesystem forces it.

## Decision

Each event note gets its **own generated id**, independent of the UID:

- **Format:** 8 lowercase letters (a-z), same length as the old suffix. Minted once, checked for uniqueness across the
  whole `07-Daily/Calendar` tree, never changed.
- **Where it lives:** frontmatter key **`lumen_file_id`**, and the filename becomes `<slug>-<lumen_file_id>.md`, so an id can
  be found in the folders without opening files. (David wrote both `lumen-file-id` and `lumen_file_id`; underscore is
  recommended: every other key in these notes is underscored, and the shims' `parseFrontmatter` only matches
  `[a-zA-Z_]+`, so a hyphenated key would not be read.)
- **Per note, not per series:** every occurrence of a recurring event gets its own id, so the `-<recurrenceId>` date
  suffix is no longer needed for uniqueness.

## Why the migration cannot be "just rename the files"

Verified by reading `scripts/calendar-sync/sync.js` on 2026-09-26:

1. `writeOccurrence` finds an existing note **only** by recomputing `<day>/<slug>-<uid8>[-<recurrenceId>].md`. After a
   rename it finds nothing and writes a fresh note at the old name.
2. `cancelStale` is content-based (`eventKey(kind, uid, recurrenceId, utc_start)` from frontmatter), so the renamed note
   is **not** cancelled. Result: every renamed event exists twice and shows up twice in `get_calendar`.
3. `ensureSeriesMaster` and the `seriesLink` (`[[<slug>-<uid8>]]`) are also name-computed.
4. **Reads by our shims also run sync.** `get_calendar`, `calendar_personal_tomorrow` and `calendar_personal_week` call
   `syncCalendar()` (`node sync.js --days=N`) inline on every read, on top of the three crons (`--days=1` hourly,
   `--days=7` every 12h, `--days=30` every 10 days). During any window where the notes are renamed but `sync.js` is not,
   an ordinary read will create the duplicates.

So `sync.js` must change first or in the same window. The rename migration is the last step, not the first.

## Plan (order matters)

1. **Snapshot:** fresh `tar` of `07-Daily/Calendar` (the vault is also git-tracked with nightly snapshots).
2. **`sync.js` change (vault project):**
   - find an existing note by `(uid, recurrence_id)` from frontmatter in the day folder (scan the folder's notes), not by
     computed path;
   - on create, mint `lumen_file_id` and name the file `<slug>-<lumen_file_id>.md`;
   - on update, keep the note's existing `lumen_file_id` and name (rename only if the title slug changed, via the
     Obsidian CLI so links follow);
   - decide series masters (`_series/<slug>-<uid8>.md`) and `seriesLink`: they must point at the master's real name.
3. **Pause** the calendar crons (and the routine shims' inline sync, or accept a no-op sync once step 2 ships).
4. **Migrate:** for every note under `07-Daily/Calendar` (excluding `_index.md`): mint an id, `property:set` it as
   `lumen_file_id`, then `rename` the file with the Obsidian CLI (both verbs are already used by the routine shims:
   `property:set` in `appendConflictsWith`, `rename` in `renameToDeleted`). The CLI is vault-aware and should rewrite
   wikilinks; **unverified:** Obsidian's "Automatically update internal links" setting must be on, and confirm on a
   couple of linked notes before the bulk run (series links, `conflicts-with` lists, `day_index`).
5. **Resume** the crons; the next `sync.js --days=30` must be a pure no-op (no new files, no duplicates).
6. **Routine side (this project):** see below.

## Routine-side follow-ups (lumen-nanoclaw / instance repo)

- `id` in `get_calendar`/tomorrow/week: read `lumen_file_id` from frontmatter, fall back to the filename (works before
  and after the migration).
- `calendar_note_append`, `calendar_personal_edit`, `calendar_personal_delete`: accept `id` (+ `day`, default today)
  instead of a vault `path`, resolving the note by `lumen_file_id`/filename suffix in that day folder.
- `calendar_personal_add` (`writeEventNote`): mint `lumen_file_id` and name the note `<slug>-<id>.md` too (today it uses
  8 random hex characters).
- Related gap found the same day: `readDayEvents` never reads location or description, so `get_calendar` never returns
  them (`parseEventBody` already exists in `event-body.ts`).

## Open

- Series master naming and `seriesLink` after the change.
- Whether a title change should rename the file (slug) or only keep the id stable.
- Whether the Obsidian CLI rename really updates every wikilink form we use (verify first).

## Brief for the vault project's Claude (paste this)

> **Calendar event notes need a stable generated id, and `sync.js` must stop locating notes by computed filename.**
> Project: `~/Projects/obsidian/lumen-data/lumen-data/scripts/calendar-sync/` (you own `sync.js`, `lib.js`, `refile.js`,
> the crons). Background: `~/Projects/lumen-nanoclaw/docs/roadmap/calendar-file-id.md` (this document).
>
> Today a note is `<slug>-<uid.slice(0,8)>[-<recurrenceId>].md` and `writeOccurrence` finds an existing note only by
> recomputing that path. Exchange UIDs all start `040000008200E000...`, so every work event ends `-04000000`; two
> same-titled work meetings on one day compute the same path and the second overwrites the first.
>
> Wanted: each event note gets `lumen_file_id: "<8 random a-z letters>"` in frontmatter, unique across the whole
> `07-Daily/Calendar` tree, minted once and never changed; the file is named `<slug>-<lumen_file_id>.md`. Change
> `writeOccurrence` to find existing notes by `(uid, recurrence_id)` read from frontmatter in that day folder, not by path.
> New notes mint an id; updates keep it. Decide what series masters and `seriesLink` should point at.
>
> Then migrate the existing ~155 notes: for each, set `lumen_file_id` (`obsidian-cli ... property:set`) and rename the
> file (`obsidian-cli ... rename`) so wikilinks update. **Ordering is critical:** ship the `sync.js` change first, pause the
> crons during the rename (note that the routine agent's calendar tools also run `sync.js --days=N` inline on every
> read), and confirm a following `--days=30` run is a no-op. Otherwise every renamed event is duplicated. Take a
> `tar` of `07-Daily/Calendar` first. Verify that a CLI rename really rewrites wikilinks (Obsidian's "Automatically
> update internal links" setting) on a couple of linked notes before the bulk run.
