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
 * The OUTBOUND chain is also advanced by short-lived CLI subprocesses
 * (ncl.ts, host-shim.ts, via cli/sync-outbound-push.ts) over their own
 * independent connections — this module's in-memory `state.outbound` can go
 * stale the moment one of those pushes and acks. `push()` guards against
 * that with chain-lock.ts's cross-process file lock: held for as long as
 * this client has any unacked outbound push in flight, re-reading the
 * persisted chain state under the lock before computing the next seq. A
 * live incident (see docs/session-sync-transport.md) found this the hard
 * way — a host-shim.ts call advanced the chain, this client's next push
 * used its stale in-memory seq, the host rejected it as a chain mismatch,
 * and every push after that failed for the rest of the container's life
 * (the host doesn't support resync recovery on this direction — see the
 * resync_point handling below).
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

import { acquireChainLockAsync, releaseChainLock, tryAcquireChainLockSync } from './chain-lock.js';
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
interface ResyncRequest {
  type: 'resync_request';
}
interface Ack {
  type: 'ack';
  seq: number;
}

/**
 * session_sync_outbound_log is in schema.ts's OUTBOUND_SCHEMA for new
 * sessions, but existing .sync-local/outbound.db files created before this
 * table existed have no ALTER-forward migration to pick it up (same gap
 * server.ts's own ensureSyncLogTable works around for the host's log) —
 * guard defensively at point of use instead of trusting schema.ts alone.
 */
function ensureOutboundLogTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_sync_outbound_log (
    seq     INTEGER PRIMARY KEY,
    kind    TEXT NOT NULL,
    chain   TEXT NOT NULL,
    payload TEXT NOT NULL
  )`);
}

function logOutboundPush(db: Database, seq: number, kind: SyncMessageKind, chain: string, payload: unknown): void {
  ensureOutboundLogTable(db);
  db.prepare('INSERT OR REPLACE INTO session_sync_outbound_log (seq, kind, chain, payload) VALUES (?, ?, ?, ?)').run(
    seq,
    kind,
    chain,
    JSON.stringify(payload),
  );
}

interface OutboundLogRow {
  seq: number;
  kind: SyncMessageKind;
  chain: string;
  payload: string;
}

/** Every logged push past `fromSeq`, in order — what the host is missing after it reports its own position via a resync_point. */
function readOutboundLogSince(db: Database, fromSeq: number): OutboundLogRow[] {
  ensureOutboundLogTable(db);
  return db
    .prepare('SELECT seq, kind, chain, payload FROM session_sync_outbound_log WHERE seq > ? ORDER BY seq ASC')
    .all(fromSeq) as OutboundLogRow[];
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
  /**
   * Waits for all currently in-flight pushes to be acked, up to `timeoutMs`.
   * For graceful-shutdown drain (docs/session-sync-transport.md §8.2.2) —
   * the container is `--rm`, so a push that's locally durable but never
   * acked before the process exits is gone for good. Never rejects: on
   * timeout it just returns with whatever's still pending, so the caller
   * can log and exit anyway rather than hang past the kill grace period.
   */
  drain(timeoutMs: number): Promise<{ pending: number }>;
}

/**
 * Builds a session-sync client bound to a local outbound.db handle.
 * `applyInboundRow` is called for each host-pushed 'inbound' kind message,
 * once chain-verified — callers supply how to write into their local
 * inbound.db (kept out of this module so it stays independent of
 * connection.ts's read-only-by-default singleton).
 */
export function createSyncClient(
  outboundDb: Database,
  applyInboundRow: (kind: SyncMessageKind, payload: unknown) => void,
  syncLocalDir: string,
): SyncClientHandle {
  const state = loadChainState(outboundDb);
  const pending = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  let send: SyncClient['send'] | null = null;
  // Held for as long as `pending` is non-empty — see the file header's note
  // on why the outbound chain needs a cross-process lock. Tracked separately
  // from `pending.size` because a burst's last waiter can be removed by
  // either resolve() or reject() and either path must release exactly once.
  let lockHeld = false;

  function releaseLockIfIdle(): void {
    if (lockHeld && pending.size === 0) {
      lockHeld = false;
      releaseChainLock(syncLocalDir);
    }
  }

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
      // Host reporting its actual outbound position — either because our
      // last push mismatched, or because we asked (attach()'s
      // resync_request, sent on every connect/reconnect). Either way, the
      // fix is the same: replay everything logged past the host's point.
      // Safe unconditionally — replay starts strictly after what the host
      // already has, so anything it already applied is never resent (same
      // "WHERE seq > ?" semantics as server.ts's own replayInboundLog), and
      // any waiter still in `pending` for a replayed seq resolves normally
      // once the host's ack for it comes back in.
      const point = msg as ResyncPoint;
      replayOutboundLog(point.seq);
      return;
    }

    // Host-pushed row in the inbound direction — not sent by any live host
    // path yet (see file header), handled here so this module is ready once
    // it is.
    const syncMsg = msg as SyncMessage;
    const nextInboundChain = verifyChain(state.inbound.chain, syncMsg);
    if (nextInboundChain === null) {
      // Mirror server.ts's own rejection reply: report our last known-good
      // point instead of applying, so the host can decide how to resync
      // (Phase 3+ — no automatic resend built on either side yet).
      send?.('session-sync', { type: 'resync_point', seq: state.inbound.seq, chain: state.inbound.chain });
      return;
    }
    try {
      applyInboundRow(syncMsg.kind, syncMsg.payload);
    } catch (err) {
      // A throw here must not silently swallow the message: without this
      // catch, an uncaught exception inside a `ws` message-frame handler
      // gets absorbed internally (confirmed empirically against a live
      // container) — the ack is never sent, the host's pushInboundRow
      // promise just hangs forever unresolved (no error, no timeout), and
      // the row never lands locally. Loud console.error is deliberate: this
      // runs inside the container, the only way to see it is container logs.
      console.error(`[session-sync] applyInboundRow threw for kind "${syncMsg.kind}", seq ${syncMsg.seq}: ${String(err)}`);
      return;
    }
    state.inbound = { seq: syncMsg.seq, chain: nextInboundChain };
    persistChainState(outboundDb, state);
    send?.('session-sync', { type: 'ack', seq: syncMsg.seq });
  }

  // Re-transmits every logged push past `fromSeq` over the current
  // connection, in order. Pure retransmission — doesn't touch `pending` or
  // allocate new seqs, since these were already chain-computed the first
  // time they were sent (mirrors server.ts's replayInboundLog).
  function replayOutboundLog(fromSeq: number): void {
    if (!send) return;
    const rows = readOutboundLogSince(outboundDb, fromSeq);
    for (const row of rows) {
      send('session-sync', { seq: row.seq, kind: row.kind, chain: row.chain, payload: JSON.parse(row.payload) } satisfies SyncMessage);
    }
  }

  // Sends one row assuming the chain lock is already held by this client.
  // Split out of push() so a burst of same-tick calls (lockHeld already
  // true) can skip straight to sending instead of re-acquiring per call.
  function sendLocked(kind: SyncMessageKind, payload: unknown): Promise<void> {
    const seq = state.outbound.seq + 1;
    const chain = nextChain(state.outbound.chain, seq, payload);
    // Reserve the seq synchronously, before the async ack round trip — two
    // push() calls in the same tick (e.g. two mcp-tools sends back to back)
    // must never compute the same seq. Otherwise the second pending.set()
    // silently overwrites the first, and that first push's promise never
    // settles (a leaked drain()-blocking waiter — see docs/session-sync-
    // transport.md's "seq reservation" note).
    state.outbound = { seq, chain };
    return new Promise((resolve, reject) => {
      pending.set(seq, {
        resolve: () => {
          persistChainState(outboundDb, state);
          resolve();
          releaseLockIfIdle();
        },
        reject: (err) => {
          reject(err);
          releaseLockIfIdle();
        },
      });
      logOutboundPush(outboundDb, seq, kind, chain, payload);
      send!('session-sync', { seq, kind, chain, payload } satisfies SyncMessage);
    });
  }

  function push(kind: SyncMessageKind, payload: unknown): Promise<void> {
    if (!send) return Promise.reject(new Error('session-sync: client not attached to a connection yet'));

    // Already holding the lock for an earlier unacked push in this burst —
    // send synchronously, same as before this client took the cross-process
    // lock into account (keeps same-tick multi-push batching lock-free).
    if (lockHeld) return sendLocked(kind, payload);

    if (tryAcquireChainLockSync(syncLocalDir)) {
      lockHeld = true;
      // A sibling CLI subprocess (ncl.ts/host-shim.ts) may have advanced the
      // chain since our last push while we held no lock — re-read before
      // trusting state.outbound, or we'd resend a stale seq and get a
      // resync_point we can't recover from.
      state.outbound = loadChainState(outboundDb).outbound;
      return sendLocked(kind, payload);
    }

    // Contended — a CLI subprocess currently holds the lock. Wait
    // asynchronously (never Bun.sleepSync) so this doesn't stall the poll
    // loop, mcp tools, or heartbeat while it finishes.
    return acquireChainLockAsync(syncLocalDir).then(() => {
      lockHeld = true;
      state.outbound = loadChainState(outboundDb).outbound;
      return sendLocked(kind, payload);
    });
  }

  return {
    handler,
    attach(sync: SyncClient): void {
      send = sync.send;
      // Ask the host where it actually is on every (re)connect — catches a
      // push that was sent but never acked because the socket dropped
      // mid-flight, which an unsolicited resync_point alone wouldn't (the
      // host has nothing to reject; it's just never heard from us since).
      // Answered as a resync_point, handled by the same replay path above.
      send('session-sync', { type: 'resync_request' } satisfies ResyncRequest);
    },
    pushOutbound: (payload) => push('outbound', payload),
    pushAck: (payload) => push('ack', payload),
    pushSessionState: (payload) => push('session_state', payload),
    pushContainerState: (payload) => push('container_state', payload),
    drain(timeoutMs: number): Promise<{ pending: number }> {
      if (pending.size === 0) return Promise.resolve({ pending: 0 });
      return new Promise((resolve) => {
        // Poll rather than hook into every pending waiter's resolve — pending
        // entries can be added mid-drain (a push already in flight when
        // shutdown started) and this stays correct either way.
        const interval = setInterval(() => {
          if (pending.size === 0) {
            clearTimeout(timer);
            clearInterval(interval);
            resolve({ pending: 0 });
          }
        }, 20);
        const timer = setTimeout(() => {
          clearInterval(interval);
          resolve({ pending: pending.size });
        }, timeoutMs);
        timer.unref?.();
        interval.unref?.();
      });
    },
  };
}
