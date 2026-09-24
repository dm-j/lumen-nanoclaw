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

## The ideal: a collapsing task DAG (David's concept, thinking out loud, 2026-09-24)

**Not a design, and not a statement about how TaskNotes works.** It is what David would want to *see and use*, recorded so the
idea survives until there is energy for real design work.

**The goal:** always be able to pick the next thing to do from one list of *available* tasks, across every project, without
hand-tracking what is waiting on what.

**Two relations over the same tasks**

- **Decomposition:** a task can be broken into child tasks, and those into further children, to any depth. A task with no children
  is a **leaf**.
- **Dependency:** a task can be blocked by other tasks (leaf or parent), at any level.

**Rules (the graph extends downwards and collapses upwards)**

1. **Only leaves are checked by hand.** A parent has no state of its own.
2. **A parent is complete exactly when all its children are complete.** Checking off the last child completes the parent, which can
   in turn complete its own parent, and so on up the graph.
3. **A completed task no longer blocks anything.** This holds for parents too: a task that depends on a parent is released when the
   parent's last leaf is checked.
4. **Blocking extends downwards.** A leaf is blocked if it, or any of its ancestors, has an incomplete blocker: a whole
   sub-project can wait on something without marking each leaf.
5. **Available** means an incomplete leaf that is not blocked.

**The views this gives (the point of it)**

- **Available:** the unblocked leaves, across all projects. This is the list David picks from.
- **Blocked:** the blocked leaves, listed separately and **de-emphasized**, each showing what it is waiting on (the nearest
  incomplete blocker), so it is clear what completing a task would unlock.
- Optionally the whole graph as a canvas (option 1 below), for seeing the shape.

**Why it suits this system:** both lists are a pure function of the graph, so they can be computed deterministically rather than
worked out by a model: cheap enough for a per-turn injection segment for Lumen ("what can David do now") and for a tool that
answers "what is available?" exactly. Derived state (parents' completion, blocked or not) is computed on read and never stored, so
it cannot disagree with the leaves.

**Questions this raises for when it is designed** (not decisions)

- Cycles must be rejected (it has to stay a DAG); where is that enforced?
- Can a child have more than one parent (a true DAG), or is decomposition a tree with dependencies as the only cross-links?
- What does "dropped" or "cancelled" mean: does it count as complete for blocking and collapsing, or stay visible as unresolved?
- Can a parent be checked by hand while children are incomplete (an override), or is that disallowed?
- A parent with no children yet: a leaf until it is broken down?
- How are available leaves ordered (priority, deadline, project, or an explicit order field)?

**Relation to TaskNotes:** the two relations map onto properties TaskNotes already has (`projects` for containment, `blockedBy`
for dependency), so this may be buildable as a *derived view and query layer over TaskNotes* rather than a new store: compute
the states above from those properties plus each task's completion status, and render the available and blocked lists (and,
optionally, a canvas). Whether that is enough is exactly what the three-level test below is for.

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
