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

  return { toolName, shimId, description, inputSchema };
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
