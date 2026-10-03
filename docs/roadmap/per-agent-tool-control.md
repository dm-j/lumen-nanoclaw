# Finer-grained MCP/tool control per agent — noted 2026-09-30, not started

Part of the point of the Crew paradigm is that each task agent is *laser-focused*
on its one job. An agent that can see tools it has no business using is being
tempted to step out of its lane, however firmly its instructions say not to.
Not every agent needs every tool.

**Where it stands.** There is no per-group tool control. The tool allowlist is
global (`TOOL_ALLOWLIST` in `container/agent-runner/src/providers/claude.ts`),
every container registers every built-in MCP tool (`server.ts`), and
`claude-md-compose.ts` includes every module's instruction fragment for every
group. The one per-group gate is `cli_scope`, which when `disabled` also drops the
`cli` and `scheduling` fragments. So a read-only lookup agent can still call
`ask_user_question`, `send_card`, `create_agent`, `install_packages` and
`add_mcp_server`; only its `instructions.prepend.md` asks it not to.

**Why it matters.** Tools that reach the user directly (`ask_user_question`,
`send_card`) undercut "task agents never bombard David". Tools that create agents
or extend the agent's own capabilities (`create_agent`, `add_mcp_server`,
`install_packages`) undercut "Dispatcher alone decides who can do what".

**Direction (not a design).**
- A per-group allow/deny list on `container_configs` (`container.json`), applied
  by the Claude provider as `allowedTools`/`disallowedTools`, covering built-in
  MCP tools and shim tools alike.
- Module instruction fragments follow the tool list: no tool, no fragment, so
  the prompt never describes something the agent cannot call.
- Defaults per agent role, e.g. task agents deny the interactive, agent-creation
  and self-modification modules; Computation keeps `install_packages`.
- Needs a DB migration and a change to the public `lumen-nanoclaw` repo; mind the
  deploy order (host first, then the instance).

**Interim.** Until this lands, new task agents (`research` first) restrict
themselves in `instructions.prepend.md` and set `cli_scope: disabled` where they
schedule nothing. That is a soft guarantee only.
