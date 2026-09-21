# mcp-shims

Give an agent group a new MCP tool by dropping in one executable script. No MCP
server to write, no protocol code, no container rebuild.

For the step-by-step build, use the `/add-mcp-shim` skill. For the terse
reference, see the `/mcp-shims` skill. This doc is the overview: what it is,
why it exists, and the shape of a shim.

## Concept

One script = one process boundary = one MCP tool.

```
agent calls tool `weather_current`
  → container: dynamic-shims.ts (generic forwarder, no implementation in it)
  → container: `host-shim weather/current '<json args>'`
  → host: host_shim_exec delivery action → execFile mcp-shims/<group>/weather/current-host
  → script stdout → tool result
```

- The **host** walks the group's `mcp-shims/<server>/` directory at container
  spawn, runs each script with `--help` to self-describe, and writes a manifest
  into the group's `container.json`.
- The **container** reads that manifest at startup and registers one generic MCP
  tool per entry (`<server>_<name>`). The forwarder contains none of the
  script's logic.
- The **script** runs on the host, not in the container. It uses whatever the
  host has (shell, `python3`, `pnpm exec tsx`) and handles its own credentials.
  It does not go through the OneCLI gateway (see `CLAUDE.md`, "Host-side scripts
  don't get gateway injection for free").

The directory tree is the whitelist. There is no DB table of tools and nothing
to keep in sync: adding a script adds a tool, deleting it removes the tool (in
both cases after a container restart).

## Objective

Let an operator or agent add a tool cheaply, and control exactly what the agent
sees of it. Two uses:

1. **Wrap something that isn't MCP-native**: a CLI, a REST API, or a local
   script. The script does its own validation and processing, then prints a
   result.
2. **Facade, constrain, or compose a real MCP server.** The script acts as an
   MCP client. It exposes a curated slice of a large server (3 tools of 40),
   hardcodes a parameter the agent shouldn't control (a fixed repo or project
   id), validates ranges, or chains several calls behind one tool.

The scripts are also deliberately **invisible to the agent**. They live outside
`groups/<folder>/` because that directory is mounted read-write into the
agent's own container. Anything in it could be read or edited by the agent, so
the agent would be able to rewrite its own tools.

If something already speaks MCP and you want its full, unmodified tool surface,
don't shim it. Register it with `ncl groups config add-mcp-server` instead.
Use a shim when you want less than the full surface, or when there is no MCP
server at all.

## Where scripts live

```
mcp-shims/<group-folder>/<server>/<name>-host     # executable
```

- `<server>` is a namespace grouping related tools. `<name>-host` becomes the
  tool `<server>_<name>`. Both segments match `^[a-z0-9][a-z0-9_-]{0,63}$`.
- `mcp-shims/` is a sibling of `groups/` at the project root. In this install
  it is a symlink into the private instance repo (`lumen-nanoclaw-instance`) and
  is gitignored here. Scripts are versioned there, because they routinely embed
  per-install specifics such as absolute paths and local ports. See
  [instance-repo-split.md](instance-repo-split.md).
- Per-group override: `ncl groups config update --mcp-shims-dir <path>`. It is
  rarely needed.
- A script must be executable (`chmod +x`) and must resolve inside its own
  server directory. Non-executable files are skipped silently, and symlinks that
  escape the tree are rejected.

## Writing a shim: overview

1. **Pick the group, server, and tool name.** They determine the path and the
   tool name.
2. **Pick the wrapper type and language.** The wrapper is one of CLI, REST API,
   MCP-server facade, or custom logic. The language is shell, Python, or
   TypeScript (`#!/usr/bin/env -S pnpm exec tsx`). The host runs Node, so don't
   use `bun`.
3. **Decide each parameter: expose, hardcode, or validate.** Exposed and
   validated parameters go in the schema. Hardcoded ones never appear in it.
4. **Handle `--help`.** Print JSON to stdout and exit 0:

   ```json
   {
     "description": "Use when the user asks for the current weather in a city",
     "inputSchema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
     "timeoutMs": 60000
   }
   ```

   - `description` is a trigger, not documentation. It is the model's only cue
     for "now vs. not now", so lead with "Use when ..." and keep it to one line.
   - `inputSchema.type` must be `"object"`.
   - `timeoutMs` is optional. The default is 30s.
   - If `--help` is missing, times out (3s), or returns bad JSON, the tool
     falls back to a generic `{ args: string[] }` schema. It still works, but
     the model gets no guidance.
5. **Parse the argument as JSON.** The script always receives exactly one argv
   element: the whole arguments object as a JSON string (`'{"city":"Chicago"}'`),
   never separate flags. Extract fields with `jq`, `json.loads(sys.argv[1])`, or
   `JSON.parse(process.argv[2])`. The most common mistake is treating `$1` as the
   bare value. The tool registers and runs without error, but it receives the
   literal JSON text. A tool with no parameters gets `'{}'`.
6. **Print the result to stdout.** Diagnostics go to stderr.
7. **Set `PATH` explicitly** if the script uses anything outside the base OS,
   such as Homebrew, nvm, or pyenv tools. The host service runs under launchd
   with a minimal `PATH`, so a script that works in your terminal can fail with
   `command not found` when called through the host.
8. **Never inline secrets.** Read them from `.env` or a local config file.
9. **Test it the way the host calls it.** Run `<script> --help`, then
   `<script> '{"field":"value"}'` (not a bare value). If it uses external tools,
   also run `env -i PATH=/usr/bin:/bin <script> '{...}'`.
10. **Restart the container.** Run `ncl groups restart --id <agent-group-id>`.
    The manifest is rebuilt only at spawn.

A complete minimal example:

```sh
#!/bin/sh
case "${1:-}" in
  --help)
    cat <<'EOF'
{"description": "Use when the user asks for the current weather in a city", "inputSchema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
EOF
    exit 0 ;;
esac
CITY="$(printf '%s' "${1:-}" | jq -r '.city // empty')"
curl -sf "https://api.example.com/weather?city=$CITY"
```

To remove a shim, delete the script and restart the container.

## Key files

| File | Purpose |
|------|---------|
| `src/modules/host-shim/mcp-manifest.ts` | Discovers scripts, runs `--help`, builds the manifest, warns when a schema declares parameters but the source never parses JSON |
| `src/modules/host-shim/exec.ts` | `resolveMcpShimsDir`, namespaced (`server/leaf`) resolution, `timeoutFor()` |
| `src/modules/host-shim/index.ts` | Host-side `host_shim_exec` delivery-action handler |
| `container/agent-runner/src/mcp-tools/dynamic-shims.ts` | Container-side: registers one generic MCP tool per manifest entry |
| `container/agent-runner/src/cli/host-shim.ts` | The `host-shim` CLI transport, shared with `remember`/`recall` |

Related: [host-shims.md](host-shims.md) covers the older `host-shims/` family
(flat scripts that the agent calls through the Bash tool, with no schema).
mcp-shims reuse the same exec transport.
