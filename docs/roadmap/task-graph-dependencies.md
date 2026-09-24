# Grouped, ordered, dependent tasks: a possible Markdown DAG + canvas renderer (NOTED, NOT STARTED)

Raised 2026-09-24 by David, written down "before I forget again". Status: **an open worry, not a plan.** David is still working out how
to represent grouped, ordered and dependent tasks in the Obsidian tasks system he already has, and progress is slow. His fear: if that
system cannot express what he needs, he may have to build a **Markdown DAG plus a canvas renderer**.

Companion to [per-day-todos.md](per-day-todos.md), whose standing preference is to concentrate on the existing Obsidian tasks system
unless there is a serious reason not to. **Not being able to express task structure is such a reason**, so this is the item that
would tip that decision.

## What the vault already has (checked 2026-09-24)

- **TaskNotes 4.12.4** (community plugin), one Markdown note per task under `TaskNotes/Tasks/` (23 tasks today), views in
  `TaskNotes/Views/` (`tasks-default`, `kanban-default`, `agenda-default`, `calendar-default`, `relationships.base`, ...).
- The task schema, `_types/task.md` (mdbase, spec 0.2.0), already defines **`projects`** (grouping) and **`blockedBy`** (dependencies),
  each with a `tn_role`. The plugin's code references `blockedBy`, `blocking`, `dependencies`, `subtasks` and `projects`.
- Lumen reaches it through `mcp-shims/lumen-dmj/task_management/` (`tasks_capture`, `tasks_list`, `tasks_finish`, over the `mtn` CLI).

## Where the gap seems to be (not yet confirmed by hands-on use)

- **Grouping** looks covered (`projects`), **dependencies** look covered (`blockedBy` / `blocking`).
- **Ordering** among siblings (do A, then B, then C) has no obvious field; a dependency chain can imply an order but is not the same
  as a stated sequence.
- **A graph view.** Whether `relationships.base` draws or merely lists relations is unverified; nothing seen renders a DAG.
- Whether the properties, as David needs to use them, are pleasant to edit and to read for both humans and agents.

First step, before building anything: David's hands-on findings on exactly what he cannot express or see.

## If something has to be built: a derived view before a new format

Prefer the cheapest thing that keeps TaskNotes as the single source of truth:

1. **A generated Obsidian Canvas** (`.canvas`, the open JSON Canvas format: nodes plus edges, which core Obsidian renders) built from
   the existing task frontmatter (`projects` groups, `blockedBy` edges, an ordering hint if we add one). Regenerated on demand or on a
   schedule; read-only; nothing to keep in sync by hand.
2. If a field is genuinely missing, **add one property** to the task type (for example a sibling `order` or `after`), which stays
   readable by TaskNotes, `mtn`, dataview and agents.
3. Only if both fail: a separate Markdown DAG as its own source of truth. It costs a second authoritative format, an editor
   story, and agent tooling, and it would reintroduce exactly the "parallel to-do mechanism" the parked todos item advises against.

An agent-facing tool for it (for example the single `action`-style tool floated in the per-day todos item) would read the same
fields, so the structure decision should be made first.

## Open questions

- What exactly can David not represent today (ordered steps within a project? "this group must finish before that one starts"?
  parallel branches that join?), with one or two real examples.
- Should ordering be explicit (a field) or derived from `blockedBy` chains?
- Do agents need to *write* structure (set dependencies) or only read it?
