---
name: add-mcp-shim
description: Guided, step-by-step creation of one new mcp-shims tool — a script that becomes a real MCP tool for an agent group without writing an MCP server. Use when the user wants to add a new ad-hoc tool, wrap a CLI/API/existing MCP server as a tool, or says "make a shim", "add an mcp-shim tool", or similar. See the `mcp-shims` skill first if you just want the background reference instead of building one now.
---

# Add an mcp-shim tool

Walks through creating exactly one new mcp-shims tool: an executable script
placed at `mcp-shims/<folder>/<server>/<name>-host` that the host
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

**A second, easy-to-miss constraint: `PATH` is not your interactive shell's
`PATH`.** The host process that actually runs these scripts (`execFile`,
inside the long-running nanoclaw host service) does not inherit your
terminal's environment. If that service runs under launchd (the normal case
on macOS), it gets launchd's own minimal default — typically something like
`/usr/local/bin:/usr/bin:/bin:/Users/<you>/.local/bin`, **no Homebrew
(`/opt/homebrew/bin`), no nvm, no pyenv shims.** A script that shells out to
a binary installed via Homebrew/nvm/pyenv/etc. will work perfectly when you
test it by hand (your shell's `PATH` has all of that) and then fail with
`<command>: command not found` the moment it actually runs through the host
service — this is exactly the failure mode that motivated this section, see
git history for the real incident. Two fixes, pick one per script:
- Set `PATH` explicitly near the top of the script:
  `PATH="/opt/homebrew/bin:$PATH"` (adjust to wherever the tool actually
  lives — `which <tool>` in your own shell to find it).
- Or hardcode the absolute path to the binary at each call site. Note this
  alone isn't always enough: a binary installed via `npm install -g` (or
  similar) is often itself a shebang script (`#!/usr/bin/env node` etc.)
  that does its *own* `PATH` lookup for its runtime — hardcoding only the
  outer binary's path can still fail if the runtime it needs isn't found
  either. Setting `PATH` up front sidesteps this entirely, which is why
  it's the recommended default over spot-hardcoding individual paths.

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
ls mcp-shims/<folder>/ 2>/dev/null
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
ls mcp-shims/<folder>/<server>/ 2>/dev/null
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

**The calling contract, before anything else:** whatever parameters this
tool ends up with, the script never receives them as separate positional
args. This is not an MCP requirement — the model produces normal structured
parameters like any tool call, and nothing about the protocol forces raw
JSON text on a script. It's one specific layer underneath: `dynamic-shims.ts`
re-serializes that already-structured object into a single JSON string and
hands it to `host-shim` — the same generic "name + one string payload"
process-exec transport `remember`/`recall` already used, not something
parameter-aware built for this. So every call passes exactly **one** argv
element — that JSON string. A tool with `inputSchema.properties: {city:
...}` gets called as `<script> '{"city":"..."}'`, never `<script> "..."`.
The script must parse that JSON itself (`jq`, `python3 -c 'import
json,sys'`, `JSON.parse` in TypeScript) and pull out the fields it needs —
this is true regardless of which wrapper type or language you picked. A
script that treats `$1` as the bare value instead of parsing it is the most
common mistake here: it registers fine, runs fine, produces no error — and
silently receives literal JSON text instead of the value inside it. (A tool
with no parameters still gets called with `$1` = `'{}'`; harmless to ignore.)
See the `mcp-shims` skill's own "calling contract" section for the fuller
explanation of why this layer exists.

Discovery does a best-effort check for this: if the schema declares any
parameters but the script's own source has no `jq`/`JSON.parse`/`json.loads`
anywhere in it, `discoverMcpShims` logs a warning at spawn time. It's a
static text scan, not a real verification (it can't safely invoke a script
with synthetic args — that could have real side effects), so it can miss a
script that parses JSON some other way, or flag one that has the substring
for an unrelated reason. Treat it as a nudge to double-check, not proof
either way — the actual test is step 11 below.

Branch on the answer from step 4:

**CLI wrap:** Which command? How do the tool's future input parameters
(after JSON-parsing the envelope above) map to that command's args/flags/
stdin? Any output post-processing needed (the command's raw output isn't
always what the agent should see)?

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
a slow upstream call), declare it explicitly with a top-level `timeoutMs` in
the `--help` JSON from step 8 — e.g. `{"description": "...", "inputSchema":
{...}, "timeoutMs": 60000}`. This is a per-script override, read at
discovery time and threaded through the whole transport (container →
`host-shim` CLI via an env var → host's `host_shim_exec` handler →
`execHostShim`); it takes precedence over the name-prefix fallback below.

The prefix fallback still exists and still applies when no `timeoutMs` is
declared: `execHostShim`'s `timeoutFor()` checks whether the namespaced call
(`<server>/<leaf>`) starts with `digest`, `recall`, `remember`, or
`briefing` — if the *server* name starts with one of those, the call gets
180s instead of 30s. Prefer the explicit `timeoutMs` field for a new script — it's the same
`execHostShim`/`timeoutFor()` shared by plain `host-shims/` scripts too, and
those (`briefing-host` etc.) can't declare a schema at all, so the prefix
convention predates `timeoutMs` and is what they're stuck with. An mcp-shim
script has the better option now; use it instead of adopting an unrelated
prefix just to get a longer timeout.

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
  },
  "timeoutMs": 60000
}
```

Hardcoded parameters never appear in the schema — the agent shouldn't see
them as something it could set. `timeoutMs` is optional — include it only
if step 7 decided this tool needs longer than the 30s default.

### 9. Write the script

Create the directory and the script:

```bash
mkdir -p mcp-shims/<folder>/<server>
```

Unlike the rest of `groups/<folder>/`, mcp-shims scripts are **git-tracked**
(`.gitignore` carves an explicit exception — see the `mcp-shims` skill for
why). Never hardcode a credential/secret inline in the script; read it from
`.env` or a local config file the way any host-shim would, since this file
is expected to end up in version control.

Write `mcp-shims/<folder>/<server>/<name>-host` with:
- A `--help` branch printing the exact JSON from step 8 to stdout, exit 0.
- If the script shells out to anything installed outside the base OS (a
  Homebrew/nvm/pyenv-managed tool, an npm global), set `PATH` explicitly
  near the top — see the `PATH` constraint above. Don't rely on it being
  inherited.
- **Parse `$1` as JSON first**, per the calling contract in step 6, before
  doing anything else with it — every parameter this tool has lives inside
  that one JSON string, never as separate argv. In shell: `jq -r
  '.fieldname // empty'` per field (`jq` lives at `/usr/bin/jq`, no `PATH`
  fix needed for it specifically); in Python, `json.loads(sys.argv[1])`; in
  TypeScript, `JSON.parse(process.argv[2])`.
- The main logic: apply hardcoding/validation decided in step 6, do the
  wrapped call or custom logic, print the result to stdout.

Keep stdout to the actual result — anything diagnostic goes to stderr, same
convention as `briefing-host` and the other host-shim templates in
`src/host-shim-templates/`.

### 10. Make it executable

```bash
chmod +x mcp-shims/<folder>/<server>/<name>-host
```

Scripts that aren't executable are invisible to discovery — `mcp-manifest.ts`
skips anything that fails an `X_OK` check, silently (by design: a script
mid-edit shouldn't register a half-finished tool).

### 11. Test directly, before touching the container

Run it exactly as the host will:

```bash
mcp-shims/<folder>/<server>/<name>-host --help
```

Confirm the JSON is well-formed and `inputSchema.type` is `"object"` — a
schema missing that field silently falls back to the generic `{args:
string[]}` schema instead of registering (MCP requires it; the engine
fails closed rather than registering a tool the SDK would reject at call
time). Then run it **exactly as the real transport will call it — a single
JSON-string argv**, not bare values:

```bash
mcp-shims/<folder>/<server>/<name>-host '{"fieldname": "value"}'
```

Testing with `<script> value` instead of `<script> '{"fieldname":"value"}'`
will pass even though the real call would fail — the script needs to prove
it parses the envelope, not just that it works when handed a bare string.
Confirm the actual behavior is correct — this is a live test of the wrapped
CLI/API/MCP call, not a mock.

If the script shells out to anything outside the base OS, also test it with
a stripped-down `PATH` to catch the failure mode above *before* it reaches
the user, rather than after:

```bash
env -i PATH=/usr/bin:/bin mcp-shims/<folder>/<server>/<name>-host '{"fieldname": "value"}'
```

If that fails but running the script normally (your full shell `PATH`)
succeeds, you've found exactly the gap the `PATH` constraint above warns
about — fix it there before moving on.

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

**Tool creates/writes something with the literal JSON text as its value**
(a filename or title like `{"description":"..."}` instead of the actual
description). The script skipped parsing `$1` as JSON and used it as the
bare value directly — go back to the calling contract in step 6/9: `$1` is
always a JSON string of the whole arguments object, never a raw value, even
when the schema only declares one field. Fix by extracting the field with
`jq`/`json.loads`/`JSON.parse` before using it, and re-test with a real JSON
argv (step 11), not a bare string.

**Tool call fails with `<command>: command not found` even though the
script works fine when you run it yourself.** This is the `PATH` constraint
from above, almost always — the script found a bare command name via your
interactive shell's `PATH` when you tested it, but the host service's
`PATH` (launchd's minimal default, no Homebrew/nvm/pyenv) doesn't have it.
Reproduce with `env -i PATH=/usr/bin:/bin <script> <args>`; fix by setting
`PATH` explicitly at the top of the script rather than assuming it's
inherited.

**Tool call fails with a symlink/escape error.** The resolved script must
live directly inside its `mcp-shims/<server>/` directory with no symlink
pointing outside it — this is deliberate (the whitelist is the filesystem;
nothing may resolve outside the whitelisted tree).

## Removing a shim

Delete the script and, if empty, the server directory; restart the
container. No manifest entry or DB row persists anywhere else — the
directory listing at spawn time is the only source of truth.
