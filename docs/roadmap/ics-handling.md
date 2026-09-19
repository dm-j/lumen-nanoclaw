# `.ics` generation + attachment-level handling

Originally a one-line stub ("no calendar ingestion/generation yet"). Ingestion is now
done — see [routine-agent.md](routine-agent.md): `mcp-shims/routine/calendar/`
(`fetch-calendar.ts`, `ics-events.ts`) parses a personal ICS feed via `node-ical`, live
since 2026-09-16, including nontrivial recurring-event handling (overrides nested under
master events, `rrule.between()` expansion of future occurrences). Narrowed 2026-09-19
per a roadmap-staleness sweep to what's still actually unbuilt:

- **Calendar generation** — creating/writing `.ics` files or calendar events. The
  existing shims (`personal_today`/`tomorrow`/`week`) are read-only by design.
  [routine-vault-calendar.md](routine-vault-calendar.md) (currently the roadmap's `NEXT`
  item) covers a related but distinct idea — editing the vault's own local calendar
  mirror, not generating/exporting a real `.ics` file — so this item is not fully
  subsumed by that one either.
- **Channel-level `.ics` attachment handling** — e.g. parsing a calendar invite that
  arrives as an email or chat attachment. Not addressed by any existing code.

Not scoped or started for either remaining piece.
