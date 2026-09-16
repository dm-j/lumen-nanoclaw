# Dispatcher agent infrastructure

David placed `NanoClaw-Dispatcher-Agent-Prompt.md` (repo root, untracked draft) at Lumen's
request — a Dispatcher coordination-agent prompt patterned on MBIF's agent style (see
`~/Projects/obsidian/lumen-data/lumen-data/`), because MBIF's agents are notably
well-behaved and that discipline (explicit authority limits, chain discipline, structured
delegation/report templates) is worth having for Lumen's own agent tooling.

Reviewed 2026-09-15: the prompt was well-written policy but assumed infrastructure that
was only partly built — a "crew/skill registry," routing-table injection markers,
workflow-state storage, and a capability-grant frontmatter schema, none of which existed.
Worked through five gap items in order, each discussed before implementing. Status below;
all five are now resolved (three needed no new code at all — the underlying mechanism
already existed and only the prompt's mental model was wrong).

## What shipped in code

- **Migration 032** (`src/db/migrations/032-agent-group-description.ts`): nullable
  `agent_groups.description` — a one-line, human-set "when to route here" signal (not a
  what-is-it description; framed the same way as the `add-mcp-shim` skill's
  tool-description guidance: what does another agent need to see to decide *now vs. not
  now*).
- **`src/types.ts`, `src/db/agent-groups.ts`**: `AgentGroup.description` (optional field
  so existing call sites building an `AgentGroup` literal didn't all need updating),
  `createAgentGroup`/`updateAgentGroup` support it.
- **`src/cli/resources/groups.ts`**: `description` registered as a plain updatable column
  on the existing `groups` CRUD resource — `ncl groups update --id <id> --description
  "..."` — no new resource, no new subcommand.
- **`src/claude-md-compose.ts`**: `buildAgentRoutingFragment` — for any agent group with
  `agent_destinations` rows of `target_type: 'agent'`, generates an `## Available agents`
  markdown table (destination name → target's `description`) as a composed CLAUDE.md
  fragment, using the same symlink/inline-fragment machinery skill and MCP-server
  fragments already use. Groups with no agent destinations get no fragment at all.
- Set real `description`s: `lumen-dmj` ("Use when the outcome needs David's own judgment
  or a conversational reply to him directly — not for intermediate coordination steps."),
  `dispatcher` ("Use when a request needs multi-step or multi-agent coordination handled
  and reported back — not for work a single agent can just do itself."). Left
  `_ping-test` (Terminal Agent) undescribed — it's a bare bootstrap stub with no
  declared specialty, so "(no description set)" is the honest signal until it has a real
  purpose.
- Incident during rollout: rebuilding `better-sqlite3` accidentally targeted the shell's
  Node (v26.8.1) instead of the launchd service's Node (`/opt/homebrew/bin/node`,
  v22.22.2, the one that actually matters), which deleted the working native binding and
  took the host down. Fixed by rebuilding with `PATH="/opt/homebrew/bin:$PATH" pnpm
  rebuild better-sqlite3` so node-gyp/prebuild-install targeted the right binary; host
  came back clean, migration 032 applied on restart with no data loss. Worth remembering
  this repo has two Node installs in play locally and native-module rebuilds must target
  the launchd one, not whatever `node` resolves to in an interactive shell.

## What changed only in the prompt (no code)

Item-by-item, in the order discussed:

1. **Invocation mechanism.** The draft assumed "invoke an agent, inspect its return
   value" — a synchronous call. The real mechanism (`routeAgentMessage` in
   `src/modules/agent-to-agent/agent-route.ts` + `setCurrentInReplyTo` in
   `container/agent-runner/src/db/session-state.ts`) already does everything needed:
   sending a message via `send_message(to=...)` stamps `in_reply_to` when replying to an
   inbound a2a message, and `resolveTargetSession`'s reply-routing sends the answer back
   into the exact session that sent the original request, waking it. Nothing to build —
   corrected "Delegating to an agent" and "Inspecting agent results" to describe a fire-a-
   message/reply-arrives-as-a-later-message shape instead of a return value, and to say a
   work order stays outstanding between sending and that reply. The structured work-order
   and report **templates were deliberately kept as-is** (not simplified) — David's call:
   a weaker model benefits from a rigid form to fill in more than from being trusted to
   use "good judgment" about what to include; the templates are a forcing function for
   staying on-task, not protocol overhead.
2. **Registry** — see "What shipped in code" above; the `description` column plus
   `agent_destinations` (which already gates *who* can be messaged) together *are* the
   registry. No "crew registry," no per-agent capability grants, no cross-agent skill
   registry (an agent picks its own skill once it receives a work order — Dispatcher
   never needs to know another agent's installed skills, only that its declared purpose
   covers the request).
3. **Routing-table injection** — replaced the draft's
   `<!-- NANOCLAW:SKILL_ROUTING_TABLE_START/END -->` / `AGENT_ROUTING_TABLE_START/END`
   HTML-comment markers (nothing rewrites inline anchors like that anywhere in this
   codebase) with plain prose pointing at the auto-appended "Available agents" fragment
   from item 2's compose-time change. Dropped the skill routing table entirely rather
   than deferring it — it solves a cross-agent skill-dispatch problem ruled out of scope
   in item 2.
4. **Workflow-state storage.** `/workspace` inside an agent's container is the
   `data/v2-sessions/<group>/<session>/` directory bind-mounted — persistent across
   container respawns for that session, since nothing in normal host operation deletes a
   session directory (`deleteSession` only removes the DB row, and only runs as part of
   deleting the entire agent group). That's the whole storage primitive needed. Prompt
   now specifies a `workflow-state/<workflow-id>.json` file per active work order, read
   at the start of any continuing turn and written after material changes, deleted on
   completion/cancellation rather than flagged "done." Explicitly noted this state is
   scoped to *the session*, not the agent group as a whole — consistent with item 1's
   finding that replies route back to a specific session, not "the agent" in general.
5. **Enforcement vs. prose.** Stripped the entire YAML frontmatter block — `schema`,
   `mode`, `capabilities: [...]`, `reports-to`, `user-facing` were all inert (nothing in
   this codebase parses agent-prompt frontmatter). What's actually enforced already
   exists elsewhere and needs no frontmatter mirror: `agent_destinations` is the real ACL
   for who Dispatcher can message (checked by `guard.ts` on every send, independent of
   anything in the prompt), and `container_configs.cli_scope`/`.model` are the real
   levers for ncl access and model choice. Corrected `reports-to: lumen` — given item 1's
   finding, a reply already goes back to whichever session sent the work order, not to a
   hardcoded destination; hardcoding it in frontmatter would have been actively wrong if
   Dispatcher were ever invoked by someone other than Lumen. Default for everything else
   (authority limits, chain discipline, report format) stays trust-based prose, matching
   how the rest of NanoClaw treats agent instructions — no enforcement was added
   speculatively.

## Addendum 2026-09-15: MBIF cross-check

David asked how NanoClaw's MCP-shim system interacts with subagents, which surfaced a
useful side point: mcp-shims, host-shims, MCP servers, skill selection, model/provider,
and memory are all resolved **per agent group** (`mcp-shims/<group.folder>/`, etc.), never
inherited from Lumen. Nothing needs to change for this — it means purpose-built
subagents can carry large, narrow toolsets (e.g. a calendar-heavy shim set) without that
tool-definition weight ever landing in Lumen's own context, since her container only ever
sees `mcp-shims/lumen-dmj/`. Worth keeping in mind as a reason to push niche tooling onto
subagents rather than accumulating it on Lumen, independent of the coordination-discipline
motivation that started this whole roadmap item.

That prompted a direct read of the actual MBIF CLAUDE.md
(`~/Projects/obsidian/lumen-data/lumen-data/CLAUDE.md`) rather than working from
description alone. Two things worth recording:

- **Structural difference, not just prompt-craft**: MBIF's "agents" are Claude Code
  subagents (Skill tool for multi-turn stateful flows, Agent tool for single-shot
  subprocesses) invoked **synchronously within one session** — the dispatcher gets a
  result back in the same turn. This is NOT how NanoClaw agent groups talk to each other
  (separate containers, async message-and-later-reply, per item 1 above). MBIF's chain
  tracking and anti-recursion rules exist as prompt-craft hygiene on top of an already-
  simple synchronous mechanism, not as compensation for async complexity the way ours
  must. Don't mistake MBIF's architecture for a blueprint to copy mechanically — only the
  prompt-level discipline transfers, not the transport.
- **What did transfer**, added to the draft prompt: a closed-world framing ("if it's not
  in your Available agents table / installed skills / granted tools, it does not exist,"
  adapted from MBIF's blunter "IT DOES NOT EXIST" for its fixed file-based crew) in
  "Sources of truth," and an ASCII decision-flow diagram appended to "Routing order,"
  reshaped from MBIF's synchronous branch-on-return shape into our send-and-wait-for-a-
  later-reply shape.
- **What deliberately wasn't copied**: MBIF's `agents-registry.md` is hand-maintained
  markdown doing the same job as our item-2/3 DB-generated Available-agents table — no
  action needed, ours is already the more automated version of the same idea. Also raised
  and set aside: CLAUDE.md's native `@relative/path` import syntax (which
  `src/claude-md-compose.ts` already uses for shared fragments) could let a *second*
  coordinator-style agent share Dispatcher's authority/chain-discipline boilerplate as one
  more fragment instead of duplicated prose — not building this now, since only one
  Dispatcher exists and extracting a shared fragment before a second consumer exists is
  guessing at a shape with no evidence yet. Revisit if/when a second coordinator agent is
  actually created.

## Addendum 2026-09-15 (2): mandatory reply

David flagged that a delegated agent must always reply, and asked whether that's already
the default. It is not: `send_message` is an ordinary optional tool call, nothing on the
host auto-acknowledges an a2a inbound, and a delegated agent that does its work and calls
no tool afterward leaves the work order outstanding forever with no signal anything went
wrong — the exact "no timeout/no-reply detection" gap flagged as missing (but out of
scope) during the item 1 discussion. Since Dispatcher doesn't control other agents' own
prompts, the fix has to live in what Dispatcher sends: added a step 8 to "Delegating to an
agent" requiring every work order to explicitly state that a reply is mandatory, even a
one-line "done" or "blocked on X." This closes the "agent finishes and just doesn't
reply" gap but not true silent failure (a crashed container, a bug that prevents the
reply tool call from running) — that residual case still needs a timeout/no-reply
detector on Dispatcher's own side, which remains deferred per item 1's original scoping,
not solved by this change.

## What's still open

The draft prompt (`NanoClaw-Dispatcher-Agent-Prompt.md`, repo root) is now internally
consistent with what the codebase can actually do, but has not been installed as
`groups/dispatcher/instructions.prepend.md` — Dispatcher is still running its original
"experimental, open-ended, ask when ambiguous" instructions. Remaining before this is a
live agent rather than a reviewed draft:

- Decide `dispatcher`'s real `agent_destinations` (which agents it may actually route
  to — today it has none) and `cli_scope` (draft assumes it doesn't need `ncl`; confirm
  and set `disabled` if so).
- Install the draft as `groups/dispatcher/instructions.prepend.md` and restart the group.
- Give at least one other agent a `description` and a destination pointing at it, so the
  "Available agents" fragment has something real to render before trusting Dispatcher
  with live delegated work.
