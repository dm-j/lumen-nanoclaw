/**
 * session-sync client (container side): pushes local outbound.db writes to
 * the host, chain-verified in both directions, plus applying host-pushed
 * 'inbound' rows into a local inbound.db.
 *
 * Mirror of src/session-sync/server.ts's chain-tracking approach, run for
 * both directions — no shared modules cross the host/container boundary
 * (same convention as protocol.ts and transport.ts in this directory):
 *
 *   - OUTBOUND direction (messages_out/ack/session_state/container_state):
 *     the CONTAINER is chain authority. `push*()` computes nextChain,
 *     sends the row, and the host's server.ts verifies + acks it.
 *   - INBOUND direction (messages_in, and eventually delivered/destinations/
 *     session_routing): the HOST is chain authority. Host-pushed rows are
 *     chain-verified here before being handed to `applyInboundRow`.
 *
 * Checkpoint for both directions is persisted into outbound.db's own
 * `session_sync_state` table (connection.ts) after every applied/acked
 * message — a container restart re-derives it from there instead of
 * resetting to GENESIS_CHAIN, same rationale as the host side (see
 * server.ts's file header and docs/session-sync-transport.md §6).
 *
 * Usage: `handler` is registered against `connectSyncClient`'s handlers map
 * *before* connecting (transport.ts's channel-handler contract); `attach` is
 * then called with the resulting SyncClient so `push*()` has something to
 * send through. Split this way because connectSyncClient needs handlers
 * up front but only returns the send function once the connection is open.
 *
 * NOTE: the host does not push 'inbound' rows yet — server.ts is currently a
 * pure request/response channel handler with no outbound push path. The
 * applyInboundRow path here is exercised by this module's own tests only
 * until that host-side piece is built; see docs/session-sync-transport.md §6.
 */
import type { Database } from 'bun:sqlite';

import { GENESIS_CHAIN, nextChain, verifyChain, type SyncMessage, type SyncMessageKind } from './protocol.js';
import type { SyncClient } from './transport.js';

interface ChainRow {
  outbound_seq: number;
  outbound_chain: string;
  inbound_seq: number;
  inbound_chain: string;
}

interface ChainState {
  outbound: { seq: number; chain: string };
  inbound: { seq: number; chain: string };
}

function loadChainState(outboundDb: Database): ChainState {
  const row = outboundDb
    .prepare('SELECT outbound_seq, outbound_chain, inbound_seq, inbound_chain FROM session_sync_state WHERE id = 1')
    .get() as ChainRow | undefined;
  if (!row) return { outbound: { seq: 0, chain: GENESIS_CHAIN }, inbound: { seq: 0, chain: GENESIS_CHAIN } };
  return {
    outbound: { seq: row.outbound_seq, chain: row.outbound_chain },
    inbound: { seq: row.inbound_seq, chain: row.inbound_chain },
  };
}

function persistChainState(outboundDb: Database, state: ChainState): void {
  outboundDb
    .prepare(
      `INSERT INTO session_sync_state (id, outbound_seq, outbound_chain, inbound_seq, inbound_chain, updated_at)
       VALUES (1, $outbound_seq, $outbound_chain, $inbound_seq, $inbound_chain, $updated_at)
       ON CONFLICT(id) DO UPDATE SET
         outbound_seq = excluded.outbound_seq, outbound_chain = excluded.outbound_chain,
         inbound_seq = excluded.inbound_seq, inbound_chain = excluded.inbound_chain,
         updated_at = excluded.updated_at`,
    )
    .run({
      $outbound_seq: state.outbound.seq,
      $outbound_chain: state.outbound.chain,
      $inbound_seq: state.inbound.seq,
      $inbound_chain: state.inbound.chain,
      $updated_at: new Date().toISOString(),
    });
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

export interface SyncClientHandle {
  /** Channel handler — register as `handlers['session-sync']` on connectSyncClient. */
  handler(body: unknown): void;
  /** Call once connectSyncClient resolves — wires push()'s send path. */
  attach(sync: SyncClient): void;
  /** Push one outbound.db row to the host; resolves once acked. Rejects on resync mismatch — caller should stop pushing and investigate (Phase 3+ divergence recovery, not built). */
  pushOutbound(payload: unknown): Promise<void>;
  pushAck(payload: unknown): Promise<void>;
  pushSessionState(payload: unknown): Promise<void>;
  pushContainerState(payload: unknown): Promise<void>;
}

/**
 * Builds a session-sync client bound to a local outbound.db handle.
 * `applyInboundRow` is called for each host-pushed 'inbound' kind message,
 * once chain-verified — callers supply how to write into their local
 * inbound.db (kept out of this module so it stays independent of
 * connection.ts's read-only-by-default singleton).
 */
export function createSyncClient(outboundDb: Database, applyInboundRow: (payload: unknown) => void): SyncClientHandle {
  const state = loadChainState(outboundDb);
  const pending = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  let send: SyncClient['send'] | null = null;

  function handler(body: unknown): void {
    const msg = body as Ack | ResyncPoint | SyncMessage;

    if ((msg as Ack).type === 'ack') {
      const ack = msg as Ack;
      const waiter = pending.get(ack.seq);
      if (waiter) {
        pending.delete(ack.seq);
        waiter.resolve();
      }
      return;
    }

    if ((msg as ResyncPoint).type === 'resync_point') {
      // Host rejected our last push (chain mismatch) or answered a
      // resync_request. Divergence recovery (resending from the host's
      // point) is Phase 3+ — for now, reject any outstanding push so the
      // caller surfaces the problem instead of hanging silently.
      for (const [, waiter] of pending) waiter.reject(new Error('session-sync: chain resync required'));
      pending.clear();
      return;
    }

    // Host-pushed row in the inbound direction — not sent by any live host
    // path yet (see file header), handled here so this module is ready once
    // it is.
    const syncMsg = msg as SyncMessage;
    const nextInboundChain = verifyChain(state.inbound.chain, syncMsg);
    if (nextInboundChain === null) return;
    applyInboundRow(syncMsg.payload);
    state.inbound = { seq: syncMsg.seq, chain: nextInboundChain };
    persistChainState(outboundDb, state);
  }

  function push(kind: SyncMessageKind, payload: unknown): Promise<void> {
    if (!send) return Promise.reject(new Error('session-sync: client not attached to a connection yet'));
    const seq = state.outbound.seq + 1;
    const chain = nextChain(state.outbound.chain, seq, payload);
    return new Promise((resolve, reject) => {
      pending.set(seq, {
        resolve: () => {
          state.outbound = { seq, chain };
          persistChainState(outboundDb, state);
          resolve();
        },
        reject,
      });
      send!('session-sync', { seq, kind, chain, payload } satisfies SyncMessage);
    });
  }

  return {
    handler,
    attach(sync: SyncClient): void {
      send = sync.send;
    },
    pushOutbound: (payload) => push('outbound', payload),
    pushAck: (payload) => push('ack', payload),
    pushSessionState: (payload) => push('session_state', payload),
    pushContainerState: (payload) => push('container_state', payload),
  };
}
