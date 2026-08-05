/**
 * mcp-shims manifest discovery — walks a group's `mcp-shims/<server>/`
 * directories and turns each `<name>-host` executable into an MCP tool
 * definition, materialized into container.json (see ../../container-config.ts)
 * and read by the container's dynamic-shims MCP module.
 *
 * Each script may self-describe by handling `--help` and printing JSON
 * (`{description, inputSchema}`) to stdout. Anything else — no --help
 * support, nonzero exit, bad JSON — falls back to a generic schema so every
 * script works with zero required ceremony; a real schema is opt-in polish.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveMcpShimsDir } from './exec.js';
import { log } from '../../log.js';

const HELP_TIMEOUT_MS = 3_000;
const SUFFIX = '-host';

export interface McpShimManifestEntry {
  toolName: string;
  shimId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Optional per-script override for the call timeout, declared in --help's
   *  JSON (top-level `timeoutMs`). Falls back to the name-prefix heuristic
   *  (timeoutFor in exec.ts) when absent — this is the explicit escape hatch
   *  for a shim that needs longer without adopting an unrelated prefix. */
  timeoutMs?: number;
}

const FALLBACK_SCHEMA = {
  type: 'object',
  properties: { args: { type: 'array', items: { type: 'string' } } },
};

function listExecutables(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(SUFFIX)).map((e) => e.name.slice(0, -SUFFIX.length));
}

function describeShim(scriptPath: string, server: string, leaf: string): McpShimManifestEntry {
  const shimId = `${server}/${leaf}`;
  const toolName = `${server}_${leaf}`;
  const fallback: McpShimManifestEntry = {
    toolName,
    shimId,
    description: `Host shim: ${shimId}`,
    inputSchema: FALLBACK_SCHEMA,
  };

  let stdout: string;
  try {
    stdout = execFileSync(scriptPath, ['--help'], { timeout: HELP_TIMEOUT_MS, encoding: 'utf8' });
  } catch {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;

  const p = parsed as Record<string, unknown>;
  const description = typeof p.description === 'string' && p.description ? p.description : fallback.description;
  // MCP requires inputSchema.type === "object" — a schema that omits this
  // would register a tool the SDK rejects at call time, so fall back instead.
  const inputSchema =
    typeof p.inputSchema === 'object' &&
    p.inputSchema !== null &&
    (p.inputSchema as Record<string, unknown>).type === 'object'
      ? (p.inputSchema as Record<string, unknown>)
      : fallback.inputSchema;
  const timeoutMs =
    typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : undefined;

  warnIfLikelyMissingJsonParse(scriptPath, shimId, inputSchema);

  return { toolName, shimId, description, inputSchema, ...(timeoutMs ? { timeoutMs } : {}) };
}

// Every mcp-shim call passes its args as one JSON-string argv (see
// dynamic-shims.ts) — a script that declares parameters but never parses
// $1 as JSON will silently receive the literal envelope text instead of the
// field inside it (registers fine, runs fine, no error). Can't safely
// verify this by actually invoking the script (side effects), so this is a
// best-effort static text scan for a JSON-parsing idiom, not a real check —
// false positives/negatives possible, hence a warning, not a rejection.
const JSON_PARSE_HINT_RE = /\bjq\b|JSON\.parse|json\.loads/;

function warnIfLikelyMissingJsonParse(scriptPath: string, shimId: string, inputSchema: Record<string, unknown>): void {
  const properties = (inputSchema as { properties?: Record<string, unknown> }).properties;
  if (!properties || Object.keys(properties).length === 0) return; // no declared params, $1 is safely ignorable

  let source: string;
  try {
    source = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return;
  }
  if (JSON_PARSE_HINT_RE.test(source)) return;

  log.warn(
    'mcp-shim: script declares parameters but no JSON-parsing call (jq / JSON.parse / json.loads) was found in its source — every call passes $1 as a JSON envelope, never a bare value; this may be silently misreading its arguments',
    { shimId, scriptPath },
  );
}

/** Discover every mcp-shim script for a group, describing each via `--help`. */
export function discoverMcpShims(agentGroupId: string): McpShimManifestEntry[] {
  const mcpShimsDir = resolveMcpShimsDir(agentGroupId);
  if (!mcpShimsDir || !fs.existsSync(mcpShimsDir)) return [];

  const entries: McpShimManifestEntry[] = [];
  const seenToolNames = new Set<string>();

  let servers: fs.Dirent[];
  try {
    servers = fs.readdirSync(mcpShimsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  for (const serverEntry of servers) {
    const server = serverEntry.name;
    const serverDir = path.join(mcpShimsDir, server);
    for (const leaf of listExecutables(serverDir)) {
      const scriptPath = path.join(serverDir, `${leaf}${SUFFIX}`);
      try {
        fs.accessSync(scriptPath, fs.constants.X_OK);
      } catch {
        continue; // not executable
      }
      const entry = describeShim(scriptPath, server, leaf);
      if (seenToolNames.has(entry.toolName)) {
        log.warn('mcp-shim: duplicate tool name, skipping', { agentGroupId, toolName: entry.toolName });
        continue;
      }
      seenToolNames.add(entry.toolName);
      entries.push(entry);
    }
  }

  return entries;
}
