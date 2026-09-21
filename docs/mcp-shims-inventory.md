# mcp-shims inventory

Which mcp-shims exist for each agent group in this install. For what a shim is
and how to write one, see [mcp-shims.md](mcp-shims.md).

Scripts live in `mcp-shims/<group-folder>/<server>/<name>-host` (a symlink into
the private `lumen-nanoclaw-instance` repo). The tool the agent sees is
`<server>_<name>`. Snapshot taken 2026-09-21; the directory tree is the source
of truth, so re-list it (`find mcp-shims -name '*-host'`) if this drifts.

| Group (folder) | Shims | Servers |
|---|---|---|
| lumen-dmj | 21 | `memory`, `task_management`, `vault`, `vector` |
| routine | 5 | `calendar`, `daily_note` |
| dispatcher | 1 | `gaps` |
| departure | 2 (orphaned) | `travel`, `vault` |

## lumen-dmj

**`memory`** — vault-backed memory (the same backends as the `remember`/`recall`
host-shims, exposed as typed tools).

| Tool | Purpose |
|---|---|
| `memory_remember` | Capture an ad-hoc fact as a new note filed into the vault inbox (`title`, `content`, `source`, confidence). |
| `memory_recall` | Ask a question and get an answer sourced from the vault, optionally the web too (`query`, `ask_as`, length/format, `research`). |

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
| `calendar_personal_today` | Today's personal calendar, what's next, time until a meeting. |
| `calendar_personal_tomorrow` | Tomorrow's events. |
| `calendar_personal_week` | This week / next few days. |
| `daily_note_read` | Read a day's note (`today` default, `yesterday`, `tomorrow`, weekday, date). |
| `daily_note_append` | Append a note, reminder or log line to a day's note, including future days. |

The `calendar` server has helper modules alongside the `-host` wrappers
(`fetch-calendar.ts`, `filter-calendar.ts`, `ics-events.ts`, `format-event.ts`,
`group-timezone.ts`). `daily_note` shares `shared.ts`. None of these are tools:
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
