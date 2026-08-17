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
 * primary chat-inbound path via router.ts, which includes host_shim_exec
 * responses (src/modules/host-shim/index.ts) — calls this today. Task-wake
 * messages, `cli_request` inline replies, and agent-to-agent inbound also
 * write messages_in (see docs/session-sync-transport.md §6) but don't push
 * yet. If the container isn't connected at push time, pushInboundRow still
 * logs the row to session_sync_log so it's delivered on the next reconnect
 * via replayInboundLog — see that function's doc comment.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { markDeliveredSynced, openInboundDb } from '../db/session-db.js';
import { outboundDbPath } from '../session-manager.js';
import { log } from '../log.js';
import type { SyncMessageKind } from './protocol.js';
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
 * Fire-and-forget: pushes an inbound-direction write (messages_in, or one of
 * the other host-owned inbound.db tables — delivered/destinations/
 * session_routing, see notifyDeliveredWrite/notifyDestinationsWrite/
 * notifySessionRoutingWrite below) to the container if (a) a sync server is
 * running and (b) this agent group is on 'sync' transport. If (c) the
 * container isn't currently connected, pushInboundRow still logs the row to
 * session_sync_log (chain state reserved synchronously either way) so it's
 * delivered via replay on the container's next reconnect, instead of being
 * silently dropped — see docs/session-sync-transport.md §6. Errors are
 * logged, not thrown — a sync failure must never block the write path that
 * produced the row in the first place.
 */
function notifyInboundKindWrite(
  agentGroupId: string,
  sessionId: string,
  kind: SyncMessageKind,
  payload: unknown,
): void {
  if (!activeSyncServer) return;
  const config = getContainerConfig(agentGroupId);
  if (config?.transport !== 'sync') return;
  const ws = activeSyncServer.connections.get(sessionId);
  if (!ws)
    log.warn('session-sync: pushing inbound row while disconnected, deferred to reconnect replay', {
      sessionId,
      kind,
      connectedSessions: Array.from(activeSyncServer.connections.keys()),
    });

  pushInboundRow(sessionId, ws, (sid) => outboundDbPath(agentGroupId, sid), kind, payload).catch((err) => {
    log.error('session-sync: inbound push failed', { sessionId, kind, err });
  });
}

export function notifyInboundWrite(agentGroupId: string, sessionId: string, row: InboundRowPayload): void {
  notifyInboundKindWrite(agentGroupId, sessionId, 'inbound', row);
}

export interface DeliveredPayload {
  message_out_id: string;
  platform_message_id: string | null;
  status: string;
  delivered_at: string;
}

/**
 * Called after markDelivered (src/db/session-db.ts) writes a delivery
 * outcome, and again from backfillPendingDelivered (session-manager.ts) on
 * reconnect. Marks the row sync_acked once the container confirms it, so a
 * later reconnect knows not to re-send it (see
 * docs/session-sync-transport.md §8.2 item 4 / §8.6.4).
 */
export function notifyDeliveredWrite(
  agentGroupId: string,
  sessionId: string,
  row: DeliveredPayload,
  inboundDbPath?: string,
): void {
  if (!activeSyncServer) return;
  const config = getContainerConfig(agentGroupId);
  if (config?.transport !== 'sync') return;
  const ws = activeSyncServer.connections.get(sessionId);
  if (!ws) return;

  pushInboundRow(sessionId, ws, (sid) => outboundDbPath(agentGroupId, sid), 'delivered', row)
    .then(() => {
      if (!inboundDbPath) return;
      const db = openInboundDb(inboundDbPath);
      try {
        markDeliveredSynced(db, row.message_out_id);
      } finally {
        db.close();
      }
    })
    .catch((err) => {
      log.error('session-sync: inbound push failed', { sessionId, kind: 'delivered', err });
    });
}

export interface DestinationsPayload {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

/** Called after replaceDestinations (src/db/session-db.ts) overwrites the full destination map. */
export function notifyDestinationsWrite(agentGroupId: string, sessionId: string, rows: DestinationsPayload[]): void {
  notifyInboundKindWrite(agentGroupId, sessionId, 'destinations', rows);
}

export interface SessionRoutingPayload {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

/** Called after upsertSessionRouting (src/db/session-db.ts) updates the single-row routing table. */
export function notifySessionRoutingWrite(agentGroupId: string, sessionId: string, row: SessionRoutingPayload): void {
  notifyInboundKindWrite(agentGroupId, sessionId, 'session_routing', row);
}
