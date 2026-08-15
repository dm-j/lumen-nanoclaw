/**
 * session-sync channel handler (host side): chain verification, resync,
 * and applying synced rows into outbound.db. Registered against
 * transport.ts as `handlers['session-sync']` — knows nothing about
 * WebSocket/TLS/auth, only about sync semantics.
 *
 * Host writes to outbound.db here even though session-db.ts's
 * openOutboundDbRw() warns it's "only safe when no container is running" —
 * that warning is about the 'file' transport's shared mount. Under 'sync'
 * transport outbound.db is never mounted into the container at all (see
 * docs/session-sync-transport.md §3), so there's no concurrent-writer risk.
 *
 * Covers all four outbound.db tables, not just messages_out/processing_ack
 * — session_state (Chat SDK resumption) and container_state (stuck-tool
 * sweep window) would otherwise silently stop working under 'sync'
 * transport, since the host's local outbound.db copy would never receive
 * them (see docs/session-sync-transport.md §6, Phase 2 scope decision).
 * inbound.db's equivalent gap (delivered/destinations/session_routing)
 * isn't addressed here — that's the container-side sync client applying
 * host-sent rows, which doesn't exist yet.
 *
 * Chain checkpoint is persisted into outbound.db's dedicated
 * `session_sync_state` table (schema.ts — deliberately not the container's
 * own `session_state` table, to avoid a future keyspace collision if that
 * table ever gets synced too) after every applied message, not just kept
 * in memory — a host restart re-derives it from there instead of resetting
 * to GENESIS_CHAIN, which would otherwise force a full-history resync on
 * every restart.
 */
import type { WebSocket } from 'ws';

import { openOutboundDbRw } from '../db/session-db.js';
import type { SyncMessage } from './protocol.js';
import { GENESIS_CHAIN, verifyChain } from './protocol.js';
import { sendEnvelope } from './transport.js';

interface ChainState {
  outbound: { seq: number; chain: string };
}

const chainStateBySession = new Map<string, ChainState>();

function loadChainState(db: import('better-sqlite3').Database): ChainState {
  const row = db.prepare('SELECT outbound_seq, outbound_chain FROM session_sync_state WHERE id = 1').get() as
    | { outbound_seq: number; outbound_chain: string }
    | undefined;
  if (!row) return { outbound: { seq: 0, chain: GENESIS_CHAIN } };
  return { outbound: { seq: row.outbound_seq, chain: row.outbound_chain } };
}

function persistChainState(db: import('better-sqlite3').Database, state: ChainState): void {
  db.prepare(
    `INSERT INTO session_sync_state (id, outbound_seq, outbound_chain, updated_at)
     VALUES (1, @outbound_seq, @outbound_chain, @updated_at)
     ON CONFLICT(id) DO UPDATE SET outbound_seq = excluded.outbound_seq, outbound_chain = excluded.outbound_chain, updated_at = excluded.updated_at`,
  ).run({
    outbound_seq: state.outbound.seq,
    outbound_chain: state.outbound.chain,
    updated_at: new Date().toISOString(),
  });
}

function getChainState(sessionId: string, db: import('better-sqlite3').Database): ChainState {
  let state = chainStateBySession.get(sessionId);
  if (!state) {
    state = loadChainState(db);
    chainStateBySession.set(sessionId, state);
  }
  return state;
}

/** Drop cached chain state, e.g. on disconnect — next message re-derives it from outbound.db's session_state. */
export function clearChainState(sessionId: string): void {
  chainStateBySession.delete(sessionId);
}

interface ResyncRequest {
  type: 'resync_request';
}
interface ResyncPoint {
  type: 'resync_point';
  seq: number;
  chain: string;
}

/** Builds the session-sync channel handler for a given session's outbound.db path. */
export function makeSessionSyncHandler(outboundDbPathFor: (sessionId: string) => string) {
  return function handleSessionSync(sessionId: string, ws: WebSocket, body: unknown): void {
    const msg = body as SyncMessage | ResyncRequest;
    const db = openOutboundDbRw(outboundDbPathFor(sessionId));
    try {
      const state = getChainState(sessionId, db);

      if ((msg as ResyncRequest).type === 'resync_request') {
        sendEnvelope(ws, 'session-sync', {
          type: 'resync_point',
          seq: state.outbound.seq,
          chain: state.outbound.chain,
        } satisfies ResyncPoint);
        return;
      }

      const message = msg as SyncMessage;
      const nextChain = verifyChain(state.outbound.chain, message);
      if (nextChain === null) {
        sendEnvelope(ws, 'session-sync', {
          type: 'resync_point',
          seq: state.outbound.seq,
          chain: state.outbound.chain,
        } satisfies ResyncPoint);
        return;
      }

      if (message.kind === 'outbound') {
        applyOutboundRow(db, message);
      } else if (message.kind === 'ack' || message.kind === 'ack_processing') {
        applyProcessingAck(db, message);
      } else if (message.kind === 'session_state') {
        applySessionStateRow(db, message);
      } else if (message.kind === 'container_state') {
        applyContainerStateRow(db, message);
      }

      state.outbound = { seq: message.seq, chain: nextChain };
      persistChainState(db, state);
      sendEnvelope(ws, 'session-sync', { type: 'ack', seq: message.seq });
    } finally {
      db.close();
    }
  };
}

function applyOutboundRow(db: import('better-sqlite3').Database, message: SyncMessage): void {
  const row = message.payload as Record<string, unknown>;
  db.prepare(
    `INSERT OR IGNORE INTO messages_out
       (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES (@id, @seq, @in_reply_to, @timestamp, @deliver_after, @recurrence, @kind, @platform_id, @channel_type, @thread_id, @content)`,
  ).run(row);
}

function applyProcessingAck(db: import('better-sqlite3').Database, message: SyncMessage): void {
  const row = message.payload as { message_id: string; status: string; status_changed: string };
  db.prepare(
    `INSERT INTO processing_ack (message_id, status, status_changed)
     VALUES (@message_id, @status, @status_changed)
     ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, status_changed = excluded.status_changed`,
  ).run(row);
}

function applySessionStateRow(db: import('better-sqlite3').Database, message: SyncMessage): void {
  const row = message.payload as { key: string; value: string; updated_at: string };
  db.prepare(
    `INSERT INTO session_state (key, value, updated_at)
     VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(row);
}

function applyContainerStateRow(db: import('better-sqlite3').Database, message: SyncMessage): void {
  const row = message.payload as {
    current_tool: string | null;
    tool_declared_timeout_ms: number | null;
    tool_started_at: string | null;
    updated_at: string;
  };
  db.prepare(
    `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
     VALUES (1, @current_tool, @tool_declared_timeout_ms, @tool_started_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       current_tool = excluded.current_tool,
       tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
       tool_started_at = excluded.tool_started_at,
       updated_at = excluded.updated_at`,
  ).run(row);
}
