/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import type { SyncClientHandle } from './session-sync/client.js';
import { initSessionSync } from './session-sync/startup.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

// ponytail: host's stopContainer() sends SIGTERM then SIGKILL after a 1s
// grace period (container-runtime.ts's `docker stop -t 1`) — this must fit
// comfortably inside that, not the other way round. Bump the host-side grace
// for sync-transport sessions specifically if drains start timing out in
// practice.
const DRAIN_TIMEOUT_MS = 600;

/**
 * On SIGTERM/SIGKILL-imminent (SIGTERM only — SIGKILL can't be caught),
 * blocks exit until any in-flight session-sync pushes are acked or the
 * timeout elapses. Container is `--rm`, so a locally-durable-but-unacked
 * outbound row would otherwise vanish the moment the process exits (see
 * docs/session-sync-transport.md §8.2.2). No-op when not on 'sync' transport
 * (`syncClient` is null).
 */
function registerShutdownDrain(syncClient: SyncClientHandle | null): void {
  if (!syncClient) return;
  let draining = false;
  const shutdown = (signal: string): void => {
    if (draining) return;
    draining = true;
    log(`received ${signal}, draining session-sync before exit`);
    syncClient
      .drain(DRAIN_TIMEOUT_MS)
      .then(({ pending }) => {
        if (pending > 0) log(`drain timed out with ${pending} push(es) still unacked — exiting anyway`);
        process.exit(0);
      })
      .catch(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Session-sync bootstrap — no-op unless this group's container.json says
  // transport: 'sync'. Doesn't affect DB reads/writes yet (see startup.ts
  // header); just proves the connection itself works end-to-end.
  const syncClient = await initSessionSync();
  registerShutdownDrain(syncClient);

  // Every provider shares one persistent memory tree. Legacy imports are an
  // operator-run migration and never happen in this normal startup path.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Memory is
  // supplied separately by each provider's native lifecycle hook.
  const taskId = getTaskSeriesId();
  const instructions = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(
      serverConfig.type === 'http'
        ? `Additional MCP server: ${name} (HTTP)`
        : `Additional MCP server: ${name} (${serverConfig.command})`,
    );
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
