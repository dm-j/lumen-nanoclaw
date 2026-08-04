/**
 * Dynamic mcp-shims — registers one MCP tool per entry in container.json's
 * `mcpShims` (materialized host-side by discoverMcpShims, see
 * src/modules/host-shim/mcp-manifest.ts). Every tool's handler shells out to
 * the container's `host-shim` CLI with the shim's namespaced id
 * (`<server>/<leaf>`) — same transport `remember`/`recall` already use in
 * memory-fact.ts, generalized to a runtime-driven name and payload instead
 * of two hardcoded ones.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const CONFIG_PATH = '/workspace/agent/container.json';
const HOST_SHIM_TIMEOUT_MS = 220_000; // see memory-fact.ts's HOST_SHIM_TIMEOUT_MS for the layered-timeout rationale
const MAX_BUFFER = 1024 * 1024;

interface McpShimManifestEntry {
  toolName: string;
  shimId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function runHostShim(shimId: string, payload: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'host-shim',
      [shimId, payload],
      { timeout: HOST_SHIM_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function loadMcpShims(): McpShimManifestEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Array.isArray(raw.mcpShims) ? (raw.mcpShims as McpShimManifestEntry[]) : [];
  } catch {
    return [];
  }
}

const tools: McpToolDefinition[] = loadMcpShims().map((entry) => ({
  tool: {
    name: entry.toolName,
    description: entry.description,
    inputSchema: entry.inputSchema as McpToolDefinition['tool']['inputSchema'],
  },
  async handler(args) {
    const { code, stdout, stderr } = await runHostShim(entry.shimId, JSON.stringify(args));
    if (code !== 0) return err(stderr.trim() || `${entry.shimId} exited ${code}`);
    return ok(stdout.trim() || '(no output)');
  },
}));

registerTools(tools);
