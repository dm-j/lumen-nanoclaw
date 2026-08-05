---
name: add-mcp-shim
description: Guided, step-by-step creation of one new mcp-shims tool — a script that becomes a real MCP tool for an agent group without writing an MCP server. Use when the user wants to add a new ad-hoc tool, wrap a CLI/API/existing MCP server as a tool, or says "make a shim", "add an mcp-shim tool", or similar. See the `mcp-shims` skill first if you just want the background reference instead of building one now.
---

# Add an mcp-shim tool

Walks through creating exactly one new mcp-shims tool: an executable script
placed at `groups/<folder>/mcp-shims/<server>/<name>-host` that the host
discovers, self-describes, and registers as a real MCP tool the next time
that agent group's container spawns. See the `mcp-shims` skill for the
background paradigm (what this is, why it exists, host-shims vs mcp-shims,
facade/constrain/compose) — this skill is the interactive build, not the
explainer.

This is an operational skill: pure instructions, no code files of its own.
Everything it produces lands in the target agent group's own
`mcp-shims/` directory, never in core.

**Important constraint to hold in mind throughout:** the script runs **on the
host machine**, not inside the agent's container. It needs whatever the host
already has (shell, `python3`, `pnpm exec tsx` for TypeScript) — not
container-installed packages — and if it calls an external API it handles
its own credentials directly (an env var, a local config file); it is not
routed through the container's OneCLI egress proxy, since it never runs in
the container at all.

## Workflow

Ask one question at a time with `AskUserQuestion` where noted. Don't skip
ahead — later steps depend on earlier answers (the script's shape depends on
what kind of wrapper it is; the schema depends on what gets exposed).

### 1. Which agent group

Ask which agent group this tool is for. List existing groups for reference:

```bash
ncl groups list
```

Resolve to the group's `folder` (needed for the filesystem path) and its
`agentGroupId` (needed for the restart step at the end).

### 2. Server name — new or existing

List what's already there:

```bash
ls groups/<folder>/mcp-shims/ 2>/dev/null
```

Ask: reuse an existing server namespace (this tool joins others already
grouped together) or start a new one? A server name is a plain identifier —
lowercase letters, digits, hyphens, underscores, starting with a
letter/digit, max 64 chars (`^[a-z0-9][a-z0-9_-]{0,63}$`). Pick something
that groups related tools (e.g. all the tools that front one API share a
server name).

### 3. Tool name

Ask what the tool should be called (the leaf name — becomes the MCP tool
`<server>_<name>`). Same character rules as the server name. If reusing an
existing server, check the name isn't already taken:

```bash
ls groups/<folder>/mcp-shims/<server>/ 2>/dev/null
```

### 4. What kind of shim

Use `AskUserQuestion` (single-select):

- **Wrap a CLI tool** — shell out to an existing command-line program already
  on the host.
- **Wrap/facade an existing MCP server** — the script is itself an MCP
  client: connects to a real MCP server (stdio or HTTP) and calls one of its
  tools, optionally with fixed or validated parameters. Use this to expose a
  narrower slice of a bigger server, hardcode context the agent shouldn't
  control, or chain multiple calls behind one tool.
- **Wrap a REST/HTTP API** — the script makes its own HTTP call(s) directly
  (`curl`, `fetch`, `requests`, whatever the chosen language offers).
- **Custom logic** — no external thing being wrapped; the script just does
  something (local computation, filesystem, a host-side database query,
  etc.).

### 5. Language

Ask: shell (`sh`/`bash`), Python (`python3`), or TypeScript (via
`#!/usr/bin/env -S pnpm exec tsx`, since this runs on the host where `pnpm`
is already installed — not `bun`, which is the *container's* runtime, not
the host's)? Match to what the task needs — shell for a thin CLI wrapper or
simple curl call, Python for anything needing real parsing/logic, TypeScript
if it should share types/patterns with the rest of the host codebase or the
user just prefers it.

### 6. Determine the behavior

Branch on the answer from step 4:

**CLI wrap:** Which command? How do the tool's future input parameters map
to that command's args/flags/stdin? Any output post-processing needed
(the command's raw output isn't always what the agent should see)?

**MCP server facade:** How does the script reach the server — a stdio
command to spawn, or an HTTP endpoint? Which single upstream tool (or small
number of chained calls) does this shim expose? Walk through **every
parameter that upstream tool takes** and ask, per parameter:
- **Expose as-is** — the agent supplies it, unchanged.
- **Hardcode** — always send a fixed value; the agent never sees this
  parameter at all (e.g. always the same `--repo`, always the same
  `--project-id`).
- **Validate/constrain** — the agent supplies it, but the script checks it
  against a range/allowlist/pattern before passing it through.

**REST/HTTP API wrap:** Endpoint(s), method, auth mechanism (and where the
credential lives — this is host-side, so a `.env` var or a local secrets
file, not OneCLI). Same per-parameter expose/hardcode/validate pass as
above, applied to the API's query/body parameters instead of an MCP tool's.

**Custom logic:** Describe what it should do directly. Same per-parameter
pass for whatever inputs it takes, if any.

### 7. Timeout

Default timeout is 30s. If this genuinely needs longer (a subagent dispatch,
a slow upstream call), the mechanism is a **server-name prefix**, not a
per-tool setting: `execHostShim`'s `timeoutFor()` checks whether the
namespaced call (`<server>/<leaf>`) starts with `digest`, `recall`,
`remember`, or `briefing` — if the *server* name starts with one of those,
the call gets 180s instead of 30s. There's no arbitrary custom timeout in
v1; if the need doesn't fit the existing prefixes, say so plainly and ask
whether the user wants to adopt one of them for this server or accept the
30s ceiling.

### 8. Finalize the input schema

From the expose/hardcode/validate pass in step 6, build the actual JSON
Schema the script will self-describe via `--help`:

```json
{
  "description": "One line: what this tool does",
  "inputSchema": {
    "type": "object",
    "properties": { "...": "only the exposed/validated params" },
    "required": ["..."]
  }
}
```

Hardcoded parameters never appear in the schema — the agent shouldn't see
them as something it could set.

### 9. Write the script

Create the directory and the script:

```bash
mkdir -p groups/<folder>/mcp-shims/<server>
```

Write `groups/<folder>/mcp-shims/<server>/<name>-host` with:
- A `--help` branch printing the exact JSON from step 8 to stdout, exit 0.
- The main logic: read args, apply hardcoding/validation decided in step 6,
  do the wrapped call or custom logic, print the result to stdout.

Keep stdout to the actual result — anything diagnostic goes to stderr, same
convention as `briefing-host` and the other host-shim templates in
`src/host-shim-templates/`.

### 10. Make it executable

```bash
chmod +x groups/<folder>/mcp-shims/<server>/<name>-host
```

Scripts that aren't executable are invisible to discovery — `mcp-manifest.ts`
skips anything that fails an `X_OK` check, silently (by design: a script
mid-edit shouldn't register a half-finished tool).

### 11. Test directly, before touching the container

Run it exactly as the host will:

```bash
groups/<folder>/mcp-shims/<server>/<name>-host --help
```

Confirm the JSON is well-formed and `inputSchema.type` is `"object"` — a
schema missing that field silently falls back to the generic `{args:
string[]}` schema instead of registering (MCP requires it; the engine
fails closed rather than registering a tool the SDK would reject at call
time). Then run it with real sample arguments and confirm the actual
behavior is correct — this is a live test of the wrapped CLI/API/MCP call,
not a mock.

### 12. Restart the container

The manifest is materialized into `container.json` at spawn time, so an
already-running container won't see a script dropped in after it started:

```bash
ncl groups restart --id <agentGroupId>
```

### 13. Verify from the agent's side

Ask the user to have the agent try the new tool (`<server>_<name>`), or
check yourself that it's listed. If it doesn't appear, see Troubleshooting.

## Troubleshooting

**Tool doesn't appear after restart.** Check: script is executable
(`ls -l` shows `x`), name matches `^[a-z0-9][a-z0-9_-]{0,63}$` for both the
server and leaf segments, and the container actually restarted (a wake
without a kill won't re-read the group's `mcp-shims/` directory — the
manifest is only rebuilt at spawn).

**Tool appears but has the generic `{args: string[]}` schema instead of the
real one.** The `--help` output either isn't valid JSON, doesn't set
`inputSchema.type` to `"object"`, or the script doesn't handle `--help` at
all (nonzero exit or hung — discovery gives it 3s). Run `<script> --help`
directly and check its exit code and stdout.

**Tool call times out.** Default is 30s. See step 7 — only a server-name
prefix (`digest`, `recall`, `remember`, `briefing`) gets 180s; there's no
per-tool override yet.

**Tool call fails with a symlink/escape error.** The resolved script must
live directly inside its `mcp-shims/<server>/` directory with no symlink
pointing outside it — this is deliberate (the whitelist is the filesystem;
nothing may resolve outside the whitelisted tree).

## Removing a shim

Delete the script and, if empty, the server directory; restart the
container. No manifest entry or DB row persists anywhere else — the
directory listing at spawn time is the only source of truth.
