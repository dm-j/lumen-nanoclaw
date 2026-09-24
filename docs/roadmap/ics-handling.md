# `.ics` generation + attachment-level handling

Originally a one-line stub ("no calendar ingestion/generation yet"). Ingestion, reading and editing are now done; what is
left is narrower than this file used to say. Refreshed 2026-09-23 (the earlier text described a live ICS-feed fetch, called the
calendar shims "read-only by design", and linked a `routine-vault-calendar.md` that shipped and was deleted).

## What exists now (not this item's work)

- **Ingestion.** The vault's `scripts/calendar-sync/sync.js` (owned by the Obsidian project's Claude) fetches the `.ics` feeds on cron,
  personal and work (`kind: "work"`), and writes one note per event under `07-Daily/Calendar/YYYY/MM/DD/`.
- **Reading.** Routine's `calendar_personal_today/tomorrow/week` read that vault mirror; each event is labelled `personal`, `work`
  or `routine`.
- **Editing the mirror.** `calendar_personal_add/edit/delete` add and change events in Routine's own copy (`kind: "routine"`), never on
  the real upstream calendar; `calendar_note_append` adds comments to any event note; conflict detection and resolution is shipped
  (see roadmap.md's Closed section).

## Still unbuilt (neither is scoped or started)

- **Calendar generation.** Creating or exporting a real `.ics` file, or writing an event to the upstream calendar. Routine's add/edit
  only touch the vault mirror, by design.
- **Channel-level `.ics` attachment handling.** Parsing a calendar invite that arrives as an email or chat attachment. Not addressed by
  any existing code (email itself is roadmap item 5).
