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
import type { SyncMessage, SyncMessageKind } from './protocol.js';
import { GENESIS_CHAIN, nextChain, verifyChain } from './protocol.js';
import { sendEnvelope } from './transport.js';

interface ChainState {
  /** Container-to-host direction: container is chain authority, this side verifies. */
  outbound: { seq: number; chain: string };
  /** Host-to-container direction: host is chain authority — see pushInboundRow. */
  inbound: { seq: number; chain: string };
}

const chainStateBySession = new Map<string, ChainState>();

/**
 * inbound_seq/inbound_chain were added after session_sync_state's initial
 * release (see schema.ts) — ALTER existing rows/tables forward, same
 * PRAGMA-guarded pattern used elsewhere for inbound.db/outbound.db columns
 * (e.g. session-db.ts's `delivered`/`messages_in` columns).
 */
function ensureInboundChainColumns(db: import('better-sqlite3').Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('session_sync_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('inbound_seq')) {
    db.exec(`ALTER TABLE session_sync_state ADD COLUMN inbound_seq INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('inbound_chain')) {
    db.exec(`ALTER TABLE session_sync_state ADD COLUMN inbound_chain TEXT NOT NULL DEFAULT ''`);
  }
}

function loadChainState(db: import('better-sqlite3').Database): ChainState {
  ensureInboundChainColumns(db);
  const row = db
    .prepare('SELECT outbound_seq, outbound_chain, inbound_seq, inbound_chain FROM session_sync_state WHERE id = 1')
    .get() as { outbound_seq: number; outbound_chain: string; inbound_seq: number; inbound_chain: string } | undefined;
  if (!row) return { outbound: { seq: 0, chain: GENESIS_CHAIN }, inbound: { seq: 0, chain: GENESIS_CHAIN } };
  return {
    outbound: { seq: row.outbound_seq, chain: row.outbound_chain },
    // Empty string covers rows written before inbound_chain existed (ALTER
    // default) — genesis is the correct "nothing pushed yet" state either way.
    inbound: { seq: row.inbound_seq, chain: row.inbound_chain || GENESIS_CHAIN },
  };
}

function persistChainState(db: import('better-sqlite3').Database, state: ChainState): void {
  ensureInboundChainColumns(db);
  db.prepare(
    `INSERT INTO session_sync_state (id, outbound_seq, outbound_chain, inbound_seq, inbound_chain, updated_at)
     VALUES (1, @outbound_seq, @outbound_chain, @inbound_seq, @inbound_chain, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       outbound_seq = excluded.outbound_seq, outbound_chain = excluded.outbound_chain,
       inbound_seq = excluded.inbound_seq, inbound_chain = excluded.inbound_chain,
       updated_at = excluded.updated_at`,
  ).run({
    outbound_seq: state.outbound.seq,
    outbound_chain: state.outbound.chain,
    inbound_seq: state.inbound.seq,
    inbound_chain: state.inbound.chain,
    updated_at: new Date().toISOString(),
  });
}

/**
 * session_sync_log was added after this file's initial release — every
 * session's outbound.db created before that point has no such table, and
 * session DBs (unlike the central DB) have no ALTER-forward migration
 * system, only a one-time ensureSchema() at creation. Same forward-compat
 * pattern as ensureInboundChainColumns above, applied per-call rather than
 * relying on schema.ts's CREATE TABLE IF NOT EXISTS ever running again for
 * an already-existing file.
 */
function ensureSyncLogTable(db: import('better-sqlite3').Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_sync_log (
    seq     INTEGER PRIMARY KEY,
    kind    TEXT NOT NULL,
    chain   TEXT NOT NULL,
    payload TEXT NOT NULL
  )`);
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
interface Ack {
  type: 'ack';
  seq: number;
}

/**
 * Pending host-initiated inbound pushes awaiting the container's ack, keyed
 * by sessionId then seq — mirrors the container-side `pending` map in
 * client.ts's push(), one level up since the host serves many sessions.
 */
const pendingInboundBySession = new Map<string, Map<number, { resolve: () => void; reject: (err: Error) => void }>>();

/** Builds the session-sync channel handler for a given session's outbound.db path. */
export function makeSessionSyncHandler(outboundDbPathFor: (sessionId: string) => string) {
  return function handleSessionSync(sessionId: string, ws: WebSocket, body: unknown): void {
    const msg = body as SyncMessage | ResyncRequest | Ack | ResyncPoint;

    // Replies to a host-initiated inbound push (pushInboundRow below) — these
    // don't touch outbound.db, so handle them before opening it.
    if ((msg as Ack).type === 'ack') {
      const pending = pendingInboundBySession.get(sessionId);
      const waiter = pending?.get((msg as Ack).seq);
      if (waiter) {
        pending!.delete((msg as Ack).seq);
        waiter.resolve();
      }
      return;
    }
    if ((msg as ResyncPoint).type === 'resync_point' && (msg as SyncMessage).kind === undefined) {
      // Container reported its last-known-good (seq, chain) for the inbound
      // direction — either a genuine chain mismatch, or just "replay
      // whatever you have past this point" after a reconnect. Host is chain
      // authority for this direction, so it replays from its own durable
      // session_sync_log rather than just erroring out.
      const point = msg as ResyncPoint;
      const db = openOutboundDbRw(outboundDbPathFor(sessionId));
      try {
        replayInboundLog(sessionId, ws, db, point.seq);
      } finally {
        db.close();
      }
      return;
    }

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
      const advanced = verifyChain(state.outbound.chain, message);
      if (advanced === null) {
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

      state.outbound = { seq: message.seq, chain: advanced };
      persistChainState(db, state);
      sendEnvelope(ws, 'session-sync', { type: 'ack', seq: message.seq });
    } finally {
      db.close();
    }
  };
}

/**
 * Pushes one row to the container in the host-to-container direction (host
 * is chain authority). Resolves once the container acks; rejects if the
 * container reports a chain mismatch (`resync_point`) — same "surface it,
 * don't auto-recover" contract as client.ts's push(). The row is always
 * reserved a seq/chain and logged to session_sync_log first, regardless of
 * connection state — that's what lets replayInboundLog recover it on the
 * container's next reconnect. If `ws` is undefined (container not currently
 * connected), the row is logged and this resolves immediately without
 * attempting a live send; the container picks it up via replay instead.
 */
export function pushInboundRow(
  sessionId: string,
  ws: WebSocket | undefined,
  outboundDbPathFor: (sessionId: string) => string,
  kind: SyncMessageKind,
  payload: unknown,
): Promise<void> {
  const db = openOutboundDbRw(outboundDbPathFor(sessionId));
  let state: ChainState;
  try {
    state = getChainState(sessionId, db);
  } finally {
    db.close();
  }

  const seq = state.inbound.seq + 1;
  const chain = nextChain(state.inbound.chain, seq, payload);
  // Reserve the seq synchronously, before the async ack round trip — two
  // pushInboundRow calls for the same session in one tick (e.g. delivery.ts's
  // undelivered-message loop firing notifyDeliveredWrite per message) must
  // never compute the same seq. Otherwise the second pending.set() silently
  // overwrites the first, and that first push's promise never settles (a
  // leaked drain()-blocking waiter on the container side, or a resync_point
  // storm here).
  state.inbound = { seq, chain };

  {
    const logDb = openOutboundDbRw(outboundDbPathFor(sessionId));
    try {
      ensureSyncLogTable(logDb);
      logDb
        .prepare('INSERT OR REPLACE INTO session_sync_log (seq, kind, chain, payload) VALUES (?, ?, ?, ?)')
        .run(seq, kind, chain, JSON.stringify(payload));
    } finally {
      logDb.close();
    }
  }

  if (!ws) {
    // Not connected right now — the row is already durably logged above, so
    // the next reconnect's replayInboundLog will deliver it. Persist the
    // reserved chain state immediately (mirrors the resolve() path below)
    // so a second concurrent push doesn't reserve the same seq.
    const persistDb = openOutboundDbRw(outboundDbPathFor(sessionId));
    try {
      persistChainState(persistDb, state);
    } finally {
      persistDb.close();
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let pending = pendingInboundBySession.get(sessionId);
    if (!pending) {
      pending = new Map();
      pendingInboundBySession.set(sessionId, pending);
    }
    pending.set(seq, {
      resolve: () => {
        const persistDb = openOutboundDbRw(outboundDbPathFor(sessionId));
        try {
          persistChainState(persistDb, state);
        } finally {
          persistDb.close();
        }
        resolve();
      },
      reject,
    });
    sendEnvelope(ws, 'session-sync', { seq, kind, chain, payload } satisfies SyncMessage);
  });
}

/**
 * Replays every host-to-container push logged with seq > fromSeq, in order,
 * reusing each row's original seq/chain (the container verifies against
 * its own chain, which must match exactly what was originally computed).
 * Doesn't await acks between rows — the container processes them in the
 * order they arrive over the same socket and acks each via the normal
 * 'ack' handler, which resolves whatever pushInboundRow waiter is still
 * pending for that seq.
 */
function replayInboundLog(
  sessionId: string,
  ws: WebSocket,
  db: import('better-sqlite3').Database,
  fromSeq: number,
): void {
  ensureSyncLogTable(db);
  const rows = db
    .prepare('SELECT seq, kind, chain, payload FROM session_sync_log WHERE seq > ? ORDER BY seq ASC')
    .all(fromSeq) as Array<{ seq: number; kind: SyncMessageKind; chain: string; payload: string }>;
  for (const row of rows) {
    sendEnvelope(ws, 'session-sync', {
      seq: row.seq,
      kind: row.kind,
      chain: row.chain,
      payload: JSON.parse(row.payload),
    } satisfies SyncMessage);
  }
}

/**
 * Resends every inbound push for this session still awaiting an ack (i.e.
 * sent before a disconnect and never confirmed) over a freshly (re)connected
 * socket. Call from onConnect. Reuses replayInboundLog with the container's
 * last-acked seq — since every entry still in pendingInboundBySession was
 * pushed after that point by construction (state.inbound only advances once
 * the row is logged and sent), replaying "everything since last-acked" is
 * exactly "everything still pending" plus nothing extra.
 */
export function replayPendingInbound(
  sessionId: string,
  ws: WebSocket,
  outboundDbPathFor: (sessionId: string) => string,
): void {
  const pending = pendingInboundBySession.get(sessionId);
  if (!pending || pending.size === 0) return;
  const db = openOutboundDbRw(outboundDbPathFor(sessionId));
  try {
    const state = getChainState(sessionId, db);
    // state.inbound.seq is the *reserved* high-water mark, which includes
    // whatever's still pending — so replay from the lowest still-pending
    // seq minus one, not from state.inbound.seq itself.
    const fromSeq = Math.min(...pending.keys()) - 1;
    replayInboundLog(sessionId, ws, db, fromSeq);
  } finally {
    db.close();
  }
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
  const row = message.payload as { key: string; value: string | null; updated_at: string };
  // value: null is the container's deleteValue() signal (db/session-state.ts) —
  // session_state.value is NOT NULL, so a delete can't be expressed as an upsert.
  if (row.value === null) {
    db.prepare('DELETE FROM session_state WHERE key = ?').run(row.key);
    return;
  }
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
