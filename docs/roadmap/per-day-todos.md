# Per-day todos + a single `todo` MCP tool (PROPOSED, PARKED)

Raised 2026-09-23. **Parked ("pin in it") on David's decision the same day.** Nothing here is built and nothing is scheduled.

> **Preference recorded, read this first.** Obsidian **already has a tasks system set up: TaskNotes** (community plugin `tasknotes`; the
> vault's `TaskNotes/` folder, one note per task with tags, contexts, projects, priority and dates; 23 tasks on 2026-09-23), and
> Lumen already reaches it through `mcp-shims/lumen-dmj/task_management/` (`tasks_capture`, `tasks_list`, `tasks_finish`, a thin
> wrapper over the `mtn` CLI). That gives David a human- and AI-accessible tasks client **everywhere he already works**. **We should
> concentrate on that, and only build a parallel to-do mechanism if there is a serious reason to prefer it.** This document exists so
> the idea, and the design thinking already done, are not lost, not as a plan to build it.

## The proposal, as first described

A **Todo** can be set for any day. Each day's `_index.md` gets its own quote block with a block ID, `^todos`, holding Markdown checklist
items whose block IDs make them addressable, in the same shape as the `^daily-notes` block
([routine-daily-notes.md](routine-daily-notes.md)):

```markdown
## Todos

> - [ ] Email Scott back ^erhaen
> - [x] Take out trash ^k3m9qa

^todos
```

**One MCP tool**, `todos_todo` (server `todos`, leaf `todo`), simple and concise:

| Param | Meaning |
|---|---|
| `date` (optional) | same rules as the notes tools: today (default), yesterday, tomorrow, weekday names, unique prefixes, `YYYY-MM-DD` |
| `action` | `new`, `delete`, `replace`, `check`, `uncheck` (quietly accepts obvious synonyms: `toggle`, `complete`, `tick`, ...) |
| `id` (optional) | omitted for `new`; otherwise matched, trimmed and case-insensitive, against the items inside that day's `^todos` block |
| `content` (optional) | the todo text ("take out trash") |
| `deadline` (optional) | free text (a date, time or datetime, in local time), prepended to the content |

## Refinements suggested in review (all optional)

1. **Add a read action.** All five actions are writes. Add `list`, and make it the default when no action is given, so she can ask what is
   on any day.
2. **Rollover.** If injection only shows today's block, an item left unchecked yesterday silently drops out of view. Preferred: the
   injection segment shows today's items plus unchecked ones from the last N days, labelled with their origin day; and an `id` given
   without a `date` is looked up by scanning a window of days (David's rule for tool arguments: one simple documented form, parsed
   generously; refuse only ambiguity or malformed input).
   The alternative is a nightly carry-over like the notes one, which loses the original date.
3. **`action` must be a plain string, not a JSON-schema enum**: a client that validates against the schema would reject synonyms
   before the tool sees them. List the five canonical values in the description; resolve synonyms with an alias table, then unique prefix.
4. **Deadline syntax.** A bare prepended deadline means `replace` cannot tell it from content, so an edit silently drops it. A tiny fixed
   form such as `(by Fri 3pm) Email Scott back` lets replace keep an existing deadline when none is passed.
5. **Completion is `- [x]`, not strikethrough** (`~~...~~` stays reserved). Injection shows unchecked items only, plus a count done.
   Delete reuses the notes convention (`-deleted` appended to the ID; the ID alone hides it).
6. **Optional fuzzy fallback:** an ID-requiring action with content but no ID matches a unique unchecked item by its text; an ambiguous
   match is refused, listing candidates with their IDs.
7. **Shared code.** Generalize `mcp-shims/routine/notes/notes-block.ts` into one library for a `> ` block of ID'd list items keyed by
   its marker, so `^todos` and `^daily-notes` share IDs, dedupe, compare-and-write and day resolution.
8. **Vault side.** The `refile.js` empty-folder deletion bug must also protect a non-empty `^todos` block, not only `^daily-notes`
   ([vault-sync-handoff-brief.md](vault-sync-handoff-brief.md)); the daily-note template and insert-if-missing would gain the block.

## What is worth keeping regardless: the single-tool shape

David likes **one concise `todos` tool with an `action` parameter** over separate tools per verb. Even if the per-day block is never
built, that shape could front TaskNotes: e.g. one tool whose actions (`new`, `list`, `check`, `replace`, `delete`) call `mtn`, replacing
the three `task_management` shims and their overlapping descriptions. Note this departs from the earlier convention of one tool per
verb (notes, calendar), so decide it deliberately.

## Reasons that would justify not just using TaskNotes

Only these, if any, should tip it toward building the per-day block:

- Per-turn injection needs a cheap, day-scoped read and `mtn list` (a process spawn per call, over all tasks) is too slow or too noisy.
- A day-scoped checklist that lives *in the daily note* proves to be a different thing David wants than a tracked task with metadata.
- The agents' ability to edit tasks safely (compare-and-write, addressable IDs) turns out to be poor against TaskNotes.
- TaskNotes turns out unable to express the structure David needs (grouped, ordered, dependent tasks): see
  [task-graph-dependencies.md](task-graph-dependencies.md), raised 2026-09-24, where that is still an open worry, not a finding.

## Open questions

- Coexist, consolidate or replace: keep `TaskNotes` for longer-lived tracked tasks and add this only as a per-day checklist (with two
  descriptions that do not overlap, so a model can tell them apart), or fold everything behind TaskNotes?
- Which agents get the tool: Lumen certainly; Routine (reminders overlap)?
- Where the injection lives: the `todo` segment of the [context-injection segments](context-injection-segments.md) design.
