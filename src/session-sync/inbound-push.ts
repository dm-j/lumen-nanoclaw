/**
 * Wiring seam between "the host wrote a new messages_in row" and
 * pushInboundRow (server.ts) — kept as its own module so session-manager.ts
 * (which knows about new inbound writes) doesn't need to import the sync
 * server singleton directly, and so this can be unit-tested without
 * spinning up a real WebSocket server.
 *
 * `registerSyncServer` is called once from src/index.ts's startup sequence,
 * right after `createSyncServer`. Before that call (or for any agent group
 * still on the default 'file' transport), `notifyInboundWrite` is a no-op —
 * exactly today's behavior for every existing install.
 *
 * Scope note: only writeSessionMessage (src/session-manager.ts) — the
 * primary chat-inbound path via router.ts — calls this today. Task-wake
 * messages, `cli_request` inline replies, and agent-to-agent inbound also
 * write messages_in (see docs/session-sync-transport.md §6) but don't push
 * yet — under 'sync' transport those rows would currently be silently lost
 * (no shared filesystem to fall back on), same as this file's own status
 * until it's wired in. Not a problem in practice yet: no agent group runs
 * 'sync' transport in production.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { outboundDbPath } from '../session-manager.js';
import { log } from '../log.js';
import { pushInboundRow } from './server.js';
import type { SyncServer } from './transport.js';

let activeSyncServer: SyncServer | undefined;

export function registerSyncServer(server: SyncServer): void {
  activeSyncServer = server;
}

/** Test-only: reset the module-level singleton between test files. */
export function clearSyncServer(): void {
  activeSyncServer = undefined;
}

export interface InboundRowPayload {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  trigger: 0 | 1;
  source_session_id: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  on_wake: 0 | 1;
}

/**
 * Fire-and-forget: pushes a newly-written messages_in row to the container
 * if (a) a sync server is running, (b) this agent group is on 'sync'
 * transport, and (c) the container is currently connected. If the container
 * isn't connected, the row is simply not pushed — it'll be missing from the
 * container's local inbound.db until the still-open reconnect/resync work
 * lands (see docs/session-sync-transport.md §6). Errors are logged, not
 * thrown — a sync failure must never block the write path that produced the
 * row in the first place.
 */
export function notifyInboundWrite(agentGroupId: string, sessionId: string, row: InboundRowPayload): void {
  if (!activeSyncServer) return;
  const config = getContainerConfig(agentGroupId);
  if (config?.transport !== 'sync') return;
  const ws = activeSyncServer.connections.get(sessionId);
  if (!ws) return;

  pushInboundRow(sessionId, ws, (sid) => outboundDbPath(agentGroupId, sid), 'inbound', row).catch((err) => {
    log.error('session-sync: inbound push failed', { sessionId, err });
  });
}
