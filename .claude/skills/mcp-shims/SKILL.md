---
name: mcp-shims
description: Reference for the mcp-shims paradigm — turning a plain executable into a real MCP tool an agent can call, without writing an MCP server. Use when the user wants to add an ad-hoc tool, wrap a CLI/API as an MCP tool, or facade/constrain/compose an existing MCP server's tools into a narrower interface.
---

# mcp-shims

A way to give an agent group a new MCP tool by dropping in one executable
script — no MCP server to write, no protocol code, no container rebuild.
This is reference documentation, not something to "run" — read it when you or
the user want to understand the mechanism. To actually build a new tool
step-by-step, use the `add-mcp-shim` skill instead — it walks through
naming, wrapper type, language, per-parameter expose/hardcode/validate
decisions, writing the script, and verifying it registers.

## The mental model

An MCP tool is normally something a whole server exposes. mcp-shims lets a
**single script** be the tool instead: one script, one process boundary, one
tool. The host discovers scripts, describes them, and materializes a manifest
into the group's `container.json`; the container reads that manifest at
startup and registers one generic MCP tool per entry, each of which just
shells out to the script via the same host-shim CLI transport `remember` and
`recall` already use.

Two different things people reach for this to build:

1. **Wrap something that isn't MCP-native** — a CLI, a REST API, a local
   script you already have. The shim script does whatever validation,
   hardcoding, or processing it wants, then prints its result.
2. **Facade, constrain, or compose a real MCP server.** Nothing stops a shim
   script from being an MCP *client* itself: it connects to a real MCP
   server (stdio or HTTP), calls one specific tool with a fixed/validated
   subset of parameters, and returns a single result. This is how you expose
   a curated slice of a big MCP server (3 tools out of 40), hardcode a
   parameter the agent shouldn't control (a fixed `--repo`, a fixed
   `--project-id`), clamp/validate ranges before they reach the real server,
   or chain two calls (possibly across two different MCP servers) behind one
   tool call. The engine doesn't care what's inside the script — an MCP
   client living inside it is just another implementation detail.

## Where scripts live

`mcp-shims/<group-folder>/<server>/<name>-host` — an executable file, at
project root, a **sibling of `groups/`, not inside it.** The directory
structure is the whitelist: nothing registers a script anywhere else, and
there's no DB table of tools to keep in sync.

- `<server>` groups related tools under one namespace (e.g. several small
  scripts front different endpoints of the same API).
- `<name>-host` becomes the MCP tool `<server>_<name>`.
- Per-group override via `container_configs.mcp_shims_dir` (`ncl groups
  config update --mcp-shims-dir <path>`) — mirrors `host-shims/`'s
  `host_shims_dir`. Rarely needed; the per-group default is already
  segregated out of the box.

**Deliberately outside `groups/<folder>/`, unlike everything else a group
owns.** `groups/<folder>/` is bind-mounted read-write into that group's own
container as `/workspace/agent` — anything living inside it is readable
*and writable* from inside the agent's own session. That's fine for a
group's working files, and CLAUDE.md/container.json get their own dedicated
read-only mounts specifically to prevent tampering — but mcp-shims scripts
are meant to be **entirely invisible** to the agent: the container only
ever gets a generic forwarder (`dynamic-shims.ts`) with zero implementation
in it, the same way a real MCP server's own source isn't visible to a
client that merely calls its tools. Putting the scripts inside
`groups/<folder>/` would defeat that — the agent could just read (or edit)
its own tool implementations directly.

**Not git-tracked** — same reasoning as `host-shims/`: scripts here
routinely embed real per-install specifics (absolute paths, local service
ports, model routing) that don't belong in version control. `.gitignore`
excludes the whole top-level `mcp-shims/` directory. If you want a script
versioned/shared, keep its canonical source under version control elsewhere
(a separate repo, a project doc) and treat the copy under `mcp-shims/` as
deployed, per-install state — the same relationship a `.env` file has to
its `.env.example`.

## Self-description (optional, but worth doing)

A script can handle `--help` and print JSON to stdout:

```json
{ "description": "What this tool does", "inputSchema": { "type": "object", "properties": { ... } } }
```

If it does: that description and schema become the tool's real MCP schema.
If it doesn't — no `--help` support, nonzero exit, bad JSON, or a schema
missing `type: "object"` (MCP requires that field; something else falls back
rather than registering a tool the SDK would reject at call time) — the
engine falls back to a generic schema: `{ args: string[] }`. Every script
works with zero required ceremony; self-description is opt-in polish, not a
requirement.

`--help` is invoked with a 3s timeout at discovery time (when the group's
container.json is materialized), separate from the timeout the tool call
itself gets at runtime.

`--help`'s JSON can also declare a top-level `timeoutMs` to override the
default 30s call timeout for this one script — the explicit alternative to
the server-name-prefix heuristic below. Threaded end to end: discovery
reads it into the manifest → the container's `dynamic-shims.ts` passes it
to the `host-shim` CLI via an env var (its own argv contract has no room
for a third concept) → the host's `host_shim_exec` handler reads it and
calls `execHostShim` with it directly, skipping `timeoutFor()`'s prefix
match. Absent `timeoutMs`, behavior is unchanged from before it existed.

Discovery also does a best-effort static check: if the schema declares any
parameters but the script's source has no `jq`/`JSON.parse`/`json.loads`
anywhere in it, a warning is logged at spawn time — a nudge toward the
mistake described in "The calling contract" below, not a real verification
(actually invoking the script to check could have side effects, so it never
does).

## The calling contract: one argv, a JSON envelope

This part is **not** an MCP requirement — MCP itself is completely normal
here: the model produces structured parameters matching the declared
`inputSchema`, same as any tool call, and the SDK hands the *shim script's
MCP tool handler* that already-structured arguments object. Nothing about
MCP forces a script to receive raw JSON text.

What actually produces the JSON-string argv is one specific layer
underneath: `dynamic-shims.ts`'s handler takes that structured object and
re-serializes the whole thing into a single JSON string, then calls
`host-shim <shimId> <that-string>` — because `host-shim` is the same generic
"name + one string payload" process-exec transport `remember`/`recall`
already used (`execFile('host-shim', [shimId, payload], ...)`), not a
typed, parameter-aware CLI invocation built for this. A "normal" CLI tool
would receive real separate flags (`--city Chicago --country US`); a
mcp-shim script instead gets one opaque blob
(`'{"city":"Chicago","country":"US"}'`), because that's what the *reused*
transport already carries, not because the protocol demands it.

So: the script does **not** receive its parameters as separate positional
args — it always gets exactly one argv element, the full arguments object as
a JSON string (`$1` in shell). A tool declared with `inputSchema.properties:
{city: ..., country: ...}` still only ever gets one argument:
`'{"city":"...","country":"..."}'`. The script is responsible for parsing
that JSON itself and pulling out the fields it needs (`jq`, `python3 -c
'import json,sys; ...'`, whatever the chosen language's stdlib offers) —
there is no destructuring anywhere upstream of the script. Treating `$1` as
the bare value (skipping the parse) is the single most common mistake when
writing one of these; the tool will appear to work — it registers, it runs,
it doesn't error — while silently receiving the literal JSON text instead of
the field inside it.

The one exception: a tool with no declared parameters (`properties: {}`)
still gets called with `$1` set to `'{}'` — safe to ignore if the script
takes no input.

## Example: a tiny wrapper

```sh
#!/bin/sh
# groups/my-group/mcp-shims/weather/current-host
case "${1:-}" in
  --help)
    cat <<'EOF'
{"description": "Get current weather for a city", "inputSchema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
EOF
    exit 0 ;;
esac
CITY="$(printf '%s' "${1:-}" | jq -r '.city // empty')"
curl -sf "https://api.example.com/weather?city=$CITY"
```

Registers as tool `weather_current`. No manifest to hand-edit, no server
process to keep running — the script itself is the whole implementation.

## Example: facading a real MCP server

A shim script can itself speak MCP as a client (small Node/Python/Bun script
using an MCP SDK, or any CLI that already speaks MCP) — connect to the real
server, call one of its tools with fixed/validated params, print the result.
The facade is invisible to the discovery engine; it just sees an executable
that takes args and returns output. This is the composition angle: constrain
what an agent can reach on a large server, hardcode context the agent
shouldn't control, or combine multiple calls behind one tool.

## Execution environment: it's the host service's `PATH`, not yours

Scripts run inside the long-running nanoclaw host process (via `execFile`),
not your interactive shell — so they inherit *that* process's environment.
If it runs under launchd (the normal case on macOS), that's launchd's own
minimal default `PATH` (typically no Homebrew, no nvm, no pyenv shims). A
script that works when you run it by hand and then fails with `<command>:
command not found` once it's actually called through the host is almost
always this — see the `add-mcp-shim` skill's `PATH` section for the fix and
how to catch it during testing before it reaches the user.

## Related to, but distinct from, real MCP servers

If something already speaks the MCP protocol, don't shim it — register it
directly via `mcpServers` in the group's container config (`ncl groups config
add-mcp-server`, or the `add_mcp_server` self-mod tool from inside a
container). The container connects to it directly and gets its full,
unmodified tool surface. Reach for a shim instead when you want *less* than
the full surface (facade/constrain/compose), or when there's no MCP server at
all and you're wrapping something else.

## Key files (for anyone extending this, not for day-to-day use)

| File | Purpose |
|------|---------|
| `src/modules/host-shim/mcp-manifest.ts` | Discovers scripts under a group's `mcp-shims/<server>/`, runs `--help` to self-describe (description, inputSchema, optional timeoutMs), builds the manifest, logs the JSON-parse-idiom warning |
| `src/modules/host-shim/exec.ts` | `resolveMcpShimsDir`, namespaced (`server/leaf`) name resolution alongside the existing flat `host-shims/` resolution, `timeoutFor()`'s prefix-based default |
| `src/modules/host-shim/index.ts` | Host-side `host_shim_exec` delivery-action handler — reads an optional per-call `timeoutMs` from the request and passes it to `execHostShim`, overriding `timeoutFor()` |
| `container/agent-runner/src/mcp-tools/dynamic-shims.ts` | Container-side: reads the manifest, registers one generic MCP tool per entry, threads a declared `timeoutMs` to the `host-shim` CLI via an env var |
| `container/agent-runner/src/cli/host-shim.ts` | The container's `host-shim` CLI transport (shared with `remember`/`recall`) — reads the `HOST_SHIM_TIMEOUT_MS_OVERRIDE` env var and includes it in the request content when set |

