# Grouped, ordered, dependent tasks: a possible Markdown DAG + canvas renderer (NOTED, NOT STARTED)

Raised 2026-09-24 by David, written down "before I forget again". Status: **an open worry, not a plan.** David is still working out how
to represent grouped, ordered and dependent tasks in the Obsidian tasks system he already has, and progress is slow. His fear: if that
system cannot express what he needs, he may have to build a **Markdown DAG plus a canvas renderer**.

**David's finding, same day (from hands-on use):** TaskNotes does not, as far as he can tell, handle **multi-level task decomposition
with dependencies** natively. He tends to build large task **graphs**, not lists: tasks broken into subtasks, those broken down
again, with dependencies between tasks at and across levels. This is a limit on hierarchy plus dependencies together, not merely
on ordering, and it is why the Markdown-DAG option is on the table. (Not yet independently verified by us; see below.)

Companion to [per-day-todos.md](per-day-todos.md), whose standing preference is to concentrate on the existing Obsidian tasks system
unless there is a serious reason not to. **Not being able to express task structure is such a reason**, so this is the item that
would tip that decision.

## What the vault already has (checked 2026-09-24)

- **TaskNotes 4.12.4** (community plugin), one Markdown note per task under `TaskNotes/Tasks/` (23 tasks today), views in
  `TaskNotes/Views/` (`tasks-default`, `kanban-default`, `agenda-default`, `calendar-default`, `relationships.base`, ...).
- The task schema, `_types/task.md` (mdbase, spec 0.2.0), already defines **`projects`** (grouping) and **`blockedBy`** (dependencies),
  each with a `tn_role`. The plugin's code references `blockedBy`, `blocking`, `dependencies`, `subtasks` and `projects`.
- Lumen reaches it through `mcp-shims/lumen-dmj/task_management/` (`tasks_capture`, `tasks_list`, `tasks_finish`, over the `mtn` CLI).

## Where the gap seems to be

- **Not obviously the data model.** The schema has `projects` (a task belongs to one or more parents, which can themselves be
  tasks: a hierarchy) and `blockedBy` (edges). Those two properties together can, in principle, store a multi-level decomposition
  *with* dependencies, so the limit may lie in what the plugin's views and queries show and edit, not in what a note can hold.
  **To verify:** build a small three-level example (project, sub-project, leaf tasks, with `blockedBy` across levels) and see what
  TaskNotes, `relationships.base` and `mtn` do with it.
- **Authoring and reading graphs at scale.** One note per task is a poor surface for a human to design a large graph: the structure
  is scattered across many files, and no view draws it. Agents can read and write the frontmatter fine; a person cannot see the shape.
- **Ordering** among siblings has no obvious field (a dependency chain implies an order but is not the same as a stated sequence).

Next step: David's real examples (a graph he wants to model), and the small three-level test above.

## If something has to be built

The need is a **graph**, so the first split is *view* versus *authoring*:

1. **A generated Obsidian Canvas as the view** (`.canvas`, the open JSON Canvas format: nodes and edges, with **group nodes** that
   nest, which map naturally onto parent tasks), built from the existing frontmatter (`projects` gives containment,
   `blockedBy` gives edges). Regenerated on demand; read-only; TaskNotes stays the source of truth. If the data model turns out to
   hold the graph fine, this alone may be enough.
2. **One added property** if a field is genuinely missing (for example a sibling `order` or `after`), readable by TaskNotes, `mtn`,
   dataview and agents.
3. **A single-file Markdown DAG as the authoring surface**, if editing a graph as many separate notes proves too painful: a nested
   list with dependency references that David edits directly, with a tool that projects it into TaskNotes notes and/or a canvas.
   Given how David works (large graphs), this is more plausible than it first looked, but it costs a second authoritative format,
   an editor story and agent tooling, and it is the "parallel to-do mechanism" the parked todos item warns about. Choose it only
   after step 1 and a real example show that the notes-and-frontmatter model cannot serve.

An agent-facing tool (for example the single `action`-style tool floated in the per-day todos item) would read the same fields, so
the structure decision should be made first.

## Open questions

- What exactly can David not represent today (ordered steps within a project? "this group must finish before that one starts"?
  parallel branches that join?), with one or two real examples.
- Should ordering be explicit (a field) or derived from `blockedBy` chains?
- Do agents need to *write* structure (set dependencies) or only read it?
