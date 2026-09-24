# mcp-shims inventory

Which mcp-shims exist for each agent group in this install. For what a shim is
and how to write one, see [mcp-shims.md](mcp-shims.md).

Scripts live in `mcp-shims/<group-folder>/<server>/<name>-host` (a symlink into
the private `lumen-nanoclaw-instance` repo). The tool the agent sees is
`<server>_<name>`. Snapshot taken 2026-09-21; the directory tree is the source
of truth, so re-list it (`find mcp-shims -name '*-host'`) if this drifts.

| Group (folder) | Shims | Servers |
|---|---|---|
| lumen-dmj | 26 | `journal`, `memory`, `notes`, `task_management`, `vault`, `vector` |
| routine | 14 | `calendar`, `daily_note`, `notes` |
| dispatcher | 1 | `gaps` |
| departure | 2 (orphaned) | `travel`, `vault` |

## lumen-dmj

**`journal`** — Lumen's own journal, one vault note per day at `07-Daily/Lumen-Journals/YYYY/MM/DD.md`.

| Tool | Purpose |
|---|---|
| `journal_entry` | `mode` = `read` or `write`. Read shows a day (`value`: today by default, `yesterday`, a weekday = the most recent one before today, unique abbreviations OK, or `YYYY-MM-DD`; no `tomorrow`); a missing day returns "No journal entry for …". Write appends `value` under a `# YYYY-MM-DD HH:mm` header as a `> ` quote block ending in a `^hh-mm-ss` block id (seconds bumped on collision). Empty `value` is an error. |

**`memory`** — vault-backed memory (the same backends as the `remember`/`recall`
host-shims, exposed as typed tools).

| Tool | Purpose |
|---|---|
| `memory_remember` | Capture an ad-hoc fact as a new note filed into the vault inbox (`title`, `content`, `source`, confidence). |
| `memory_recall` | Ask a question and get an answer sourced from the vault, optionally the web too (`query`, `ask_as`, length/format, `research`). |

**`notes`** — the ID'd notes on a day's `## Notes` block. Same code as routine's `notes` server
(`mcp-shims/routine/notes/notes.ts`); these wrappers only set which group's timezone applies and the name
stamped on notes (`lumen`). Each tool takes an optional `day` (today by default, `yesterday`, `tomorrow`, a
weekday, or `YYYY-MM-DD`).

| Tool | Purpose |
|---|---|
| `notes_read` | List a day's ID'd notes (`[id] text`), or find a note's ID before changing it. Hand-typed notes without an ID show `[?]` and are unaddressable. |
| `notes_add` | Jot down a note, reminder or log line; returns its ID. Time and `lumen` are prefixed automatically. |
| `notes_edit` | Reword one note by ID; other notes untouched. |
| `notes_delete` | Delete one note by ID. |

**`task_management`** — todo.txt-style task list.

| Tool | Purpose |
|---|---|
| `task_management_tasks_list` | List active tasks; each has a `path` to pass to `tasks_finish`. |
| `task_management_tasks_capture` | Capture a task from plain text; `#tags`, `@contexts`, `+projects`, dates and priority are parsed. |
| `task_management_tasks_finish` | Mark a task done, by `path` (preferred) or a uniquely matching title. Ambiguous matches are rejected, never guessed. |

**`vault`** — read access to the notes vault.

| Tool | Purpose |
|---|---|
| `vault_search` | Text search; returns ranked notes with path and excerpt. |
| `vault_read_wikilink` | Open a wikilink leniently (brackets, `.md`, alias, `#Heading`, `^blockId` all optional). |

**`vector`** — drives the Vector robot via the `~/Projects/vector-robot` shim.
Locomotion is bounded and gated by a hazard latch.

| Tool | Purpose |
|---|---|
| `vector_status` | Connection, hazard and sensor state. No side effects. |
| `vector_move` | Drive straight, ±500mm. Refuses (409) while a hazard is active or un-primed. |
| `vector_turn` | Turn in place, ±180°. Same hazard gate as `move`. |
| `vector_prime` | Clear the post-hazard latch so move/turn can resume. Refuses if a hazard is still live. |
| `vector_stop` | Emergency stop. Always available, never blocked. |
| `vector_head` / `vector_lift` | Set head angle / lift height (0.0-1.0). |
| `vector_say` | Text-to-speech, optional Vector voice effect. |
| `vector_screen` | Flash the face a solid RGB colour. |
| `vector_audio` | Play a WAV that already exists on the vector-robot machine's filesystem. |
| `vector_volume` | Set master volume (`LOW` to `HIGH`). |
| `vector_photo` | One still from the forward camera (1280x720, base64). |
| `vector_detect` | Capture a still and run YOLOv8n detection. First call downloads the model and is slow (60s timeout). |
| `vector_continue_action` | "Nothing new, keep him visibly alive." Fires a random small screen flash or short sound. Its description is deliberately written as the default choice on a check-in, to compete with `move`/`say`. |

## routine

| Tool | Purpose |
|---|---|
| `calendar_personal_today` | Today's personal calendar, what's next, time until a meeting. Reads the vault's local calendar-file mirror (not a live ICS fetch), syncing it inline first. |
| `calendar_personal_tomorrow` | Tomorrow's events. Same vault-backed read. |
| `calendar_personal_week` | This week / next few days. Same vault-backed read. |
| `calendar_personal_add` | Add an event to routine's own local calendar copy only — never the real upstream calendar. |
| `calendar_personal_edit` | Edit an event previously added via `calendar_personal_add`; refuses any note not owned by routine (`kind: "routine"`, not a synced `"personal"` note) to avoid fighting the sync pipeline's own staleness sweep. |
| `calendar_personal_delete` | Soft-delete an event previously added via `calendar_personal_add` — `status: "deleted"`, required reason appended to the body, filename renamed to `DELETED-<original>`. Never a real file delete; refuses non-routine-owned notes. |
| `calendar_conflict_scan` | Finds routine-owned events that plausibly collide with an independently-synced authoritative event (same day, overlapping/near time); appends the authoritative note's wikilink to the routine note's `conflicts-with` list the moment a candidate surfaces so it's never re-flagged. Called by the `calendar-conflict-check` task, chained after the vault's hourly calendar-sync cron. |
| `calendar_note_append` | Appends free text to the body of any event note by path (routine-owned or not) — used to merge routine's notes onto the authoritative record before deleting routine's duplicate. Never touches frontmatter. |
| `daily_note_read` | Read a day's note (`today` default, `yesterday`, `tomorrow`, weekday, date). |
| `daily_note_append` | Append a note, reminder or log line to a day's note, including future days. |
| `notes_read` | List a day's ID'd notes (`[id] text`); hand-typed notes without an ID show `[?]` and are unaddressable. |
| `notes_add` | Add a note to a day's `## Notes` block; returns its ID. Time and `routine` are prefixed automatically. |
| `notes_edit` | Rewrite one note by ID; other notes untouched. |
| `notes_delete` | Delete one note by ID. |

The `calendar` server has helper modules alongside the `-host` wrappers
(`vault-events.ts`, `filter-calendar.ts`, `range-events.ts`, `format-event.ts`, `conflict-scan.ts`,
`group-timezone.ts`). `daily_note` shares `shared.ts`; `notes` has `notes.ts` (I/O) and
`notes-block.ts` (pure logic, checked by `notes-block.selftest.ts`). None of these are tools:
only `*-host` files are registered.

## dispatcher

| Tool | Purpose |
|---|---|
| `gaps_log` | Log a request (its own or a delegated one) that couldn't be completed because the capability doesn't exist yet, so gaps show up as signal for future development. |

## departure (orphaned)

The Departure agent group was removed on 2026-08-29, and no agent group has the
`departure` folder any more, so these are **never registered**. They are kept as
reference for the planned Travel agent
([roadmap/travel-agent-leave-now.md](roadmap/travel-agent-leave-now.md)).

| Script | Purpose |
|---|---|
| `travel/route_time-host` | Driving time and distance between two addresses (`HOME` allowed), via Nominatim + OSRM. |
| `vault/lookup_location-host` | Look up a known address for a place name via read-only vault search. |

## Shared, not tied to a group

`mcp-shims/lib/mapbox.ts` — Mapbox helpers for the future Travel agent. Not
wired to anything: there is no Mapbox connection in the OneCLI vault, and
host-side scripts don't get gateway credential injection yet (see `CLAUDE.md`,
"Host-side scripts don't get gateway injection for free").

## Groups with no shims

`computation` and `_ping-test` (Terminal Agent) have no `mcp-shims/` directory.

## Maintenance

Update this file when a shim is added, removed or moved to another group. The
`/add-mcp-shim` skill is the natural place to remind whoever builds one.
