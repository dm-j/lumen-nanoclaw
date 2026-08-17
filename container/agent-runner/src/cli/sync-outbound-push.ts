/**
 * Shared by ncl.ts and host-shim.ts: under 'sync' transport, write and push
 * a system message through the container's own local outbound.db and the
 * host sync connection — instead of opening the host-mounted
 * /workspace/{inbound,outbound}.db files directly, which would put this
 * short-lived CLI process and the host's own applyOutboundRow write on the
 * same VirtioFS-mounted file at once (the exact concurrent-writer pattern
 * 'sync' transport exists to eliminate — see docs/session-sync-transport.md
 * §1 and §8.9).
 *
 * Two processes can race to advance the same outbound chain sequence: the
 * long-running agent-runner poll loop (via its persistent session-sync
 * client, container/agent-runner/src/session-sync/client.ts) and this
 * short-lived CLI invocation. Coordinated with session-sync/chain-lock.ts's
 * shared exclusive lock file around the read-chain / connect / push /
 * persist sequence — the same lock client.ts holds for its own in-flight
 * pushes, so a burst of CLI and in-process pushes can never interleave and
 * diverge the chain. Safe because .sync-local/ is only ever touched from
 * inside this container (never by the host), so there's no cross-mount
 * coherency concern for the lock file either, same reasoning that makes
 * .sync-local/ itself safe under 'sync' transport.
 *
 * Self-contained aside from session-sync's own pure protocol/transport
 * modules (no shared modules cross the CLI/agent-runner-core boundary,
 * matching ncl.ts's and host-shim.ts's existing convention) — reusing those
 * two specifically avoids re-deriving the Bun/ws TLS-agent workaround
 * (transport.ts's file header) and the chain-hash algorithm (protocol.ts)
 * a third time.
 */
import { Database } from 'bun:sqlite';
import { Agent } from 'https';
import fs from 'fs';
import path from 'path';

import { WebSocket } from 'ws';

import { acquireChainLockAsync, releaseChainLock, tryAcquireChainLockSync } from '../session-sync/chain-lock.js';
import { GENESIS_CHAIN, nextChain, type SyncMessageKind } from '../session-sync/protocol.js';

// Deliberately not importing connectSyncClient from ../session-sync/
// transport.js, even though it does exactly this — bun:test's
// mock.module() patches are process-global, not file-scoped (see
// transport.test.ts's own header), and session-sync/startup.test.ts mocks
// that exact module. A snapshot-at-load-time capture of the export was
// tried and did not help: bun appears to run different test files'
// `it()` bodies concurrently within one process rather than one file
// fully before the next, so there's no reliable point at which "before
// any mock.module() call ran" is guaranteed. Reimplementing the small
// connect handshake locally (same Bun/`ws`-agent TLS workaround as
// transport.ts's own header explains) fully decouples this module's
// production behavior from that file's test-time mocking.
function connectMinimalSyncClient(
  url: string,
  token: string,
  pinnedCertPem: string,
  onMessage: (channel: string, body: unknown) => void,
): Promise<{ send(channel: string, body: unknown): void; close(): void }> {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ ca: [pinnedCertPem], rejectUnauthorized: true, checkServerIdentity: () => undefined });
    // Marks this as a send-and-ack-only connection so the host's
    // `connections` map (session-sync/transport.ts) — which exists only to
    // route host-initiated pushes to the container's *persistent*
    // connection — never registers or evicts this short-lived one. Without
    // it, this connection (opened fresh per CLI invocation, closed within
    // ~seconds) would clobber the persistent connection's tracked slot and
    // then delete it on close, leaving the still-open persistent connection
    // silently untracked for any push that happens after.
    const ws = new WebSocket(url, token, { agent, headers: { 'x-session-sync-role': 'transient' } });

    ws.on('open', () => {
      resolve({
        send(channel: string, body: unknown): void {
          ws.send(JSON.stringify({ channel, body }));
        },
        close(): void {
          ws.close();
        },
      });
    });
    ws.on('error', (err) => reject(new Error(`session-sync connect failed: ${String(err)}`)));
    ws.on('message', (raw) => {
      try {
        const envelope = JSON.parse(raw.toString()) as { channel: string; body: unknown };
        onMessage(envelope.channel, envelope.body);
      } catch {
        // Not a well-formed envelope — ignore.
      }
    });
  });
}

const DEFAULT_CONFIG_PATH = '/workspace/agent/container.json';
const DEFAULT_CREDENTIALS_PATH = '/workspace/.session-sync.json';
const DEFAULT_SYNC_LOCAL_DIR = '/workspace/.sync-local';
const ACK_TIMEOUT_MS = 10_000;

let _configPath = DEFAULT_CONFIG_PATH;
let _credentialsPath = DEFAULT_CREDENTIALS_PATH;
let _syncLocalDir = DEFAULT_SYNC_LOCAL_DIR;

/** Test-only: point every path this module touches somewhere writable outside a real container. */
export function setPathsForTest(paths: { configPath: string; credentialsPath: string; syncLocalDir: string }): void {
  _configPath = paths.configPath;
  _credentialsPath = paths.credentialsPath;
  _syncLocalDir = paths.syncLocalDir;
}

export function readTransport(): 'file' | 'sync' {
  try {
    const raw = JSON.parse(fs.readFileSync(_configPath, 'utf8')) as { transport?: string };
    return raw.transport === 'sync' ? 'sync' : 'file';
  } catch {
    return 'file';
  }
}

interface Credentials {
  url: string;
  token: string;
  pinnedCertPem: string;
}

function readCredentials(): Credentials {
  return JSON.parse(fs.readFileSync(_credentialsPath, 'utf8')) as Credentials;
}

/**
 * Pushes one row to the host over a short-lived sync connection, under the
 * local chain lock — computes the next outbound seq/chain from the local
 * session_sync_state row (shared keyspace with client.ts's own outbound
 * pushes), sends, waits for the ack, and persists the advanced state.
 * Throws if the host doesn't ack within ACK_TIMEOUT_MS or reports a
 * resync_point (chain divergence — should not happen under the lock, but
 * surfaced as an error rather than silently dropped either way).
 */
async function pushOverSyncConnection(outDb: InstanceType<typeof Database>, kind: SyncMessageKind, payload: unknown): Promise<void> {
  if (!tryAcquireChainLockSync(_syncLocalDir)) await acquireChainLockAsync(_syncLocalDir);
  try {
    const row = outDb.prepare('SELECT outbound_seq, outbound_chain FROM session_sync_state WHERE id = 1').get() as
      | { outbound_seq: number; outbound_chain: string }
      | undefined;
    const seq = (row?.outbound_seq ?? 0) + 1;
    const chain = nextChain(row?.outbound_chain || GENESIS_CHAIN, seq, payload);

    const credentials = readCredentials();

    let resolveAck!: (ok: boolean) => void;
    const acked = new Promise<boolean>((resolve) => {
      resolveAck = resolve;
    });
    const timeout = setTimeout(() => resolveAck(false), ACK_TIMEOUT_MS);

    const sync = await connectMinimalSyncClient(
      credentials.url,
      credentials.token,
      credentials.pinnedCertPem,
      (channel, body) => {
        if (channel !== 'session-sync') return;
        const b = body as { type?: string; seq?: number };
        if (b.type === 'ack' && b.seq === seq) {
          clearTimeout(timeout);
          resolveAck(true);
        } else if (b.type === 'resync_point') {
          clearTimeout(timeout);
          resolveAck(false);
        }
      },
    );

    try {
      sync.send('session-sync', { seq, kind, chain, payload });
      const ok = await acked;
      if (!ok) throw new Error('sync-outbound-push: push was not acked (timeout or chain resync required)');

      outDb
        .prepare(
          `INSERT INTO session_sync_state (id, outbound_seq, outbound_chain, inbound_seq, inbound_chain, updated_at)
           VALUES (1, $seq, $chain, COALESCE((SELECT inbound_seq FROM session_sync_state WHERE id = 1), 0),
                   COALESCE((SELECT inbound_chain FROM session_sync_state WHERE id = 1), ''), $updated_at)
           ON CONFLICT(id) DO UPDATE SET
             outbound_seq = excluded.outbound_seq, outbound_chain = excluded.outbound_chain, updated_at = excluded.updated_at`,
        )
        .run({ $seq: seq, $chain: chain, $updated_at: new Date().toISOString() });
    } finally {
      sync.close();
    }
  } finally {
    releaseChainLock(_syncLocalDir);
  }
}

/**
 * Writes a system message row into the local outbound.db (same shape
 * agent-runner's own writeMessageOut produces) and pushes it to the host.
 * `content` is the parsed body — this stringifies it, matching the existing
 * ncl.ts/host-shim.ts convention.
 */
export async function writeAndPushSystemMessage(id: string, content: unknown): Promise<void> {
  const outDb = new Database(path.join(_syncLocalDir, 'outbound.db'));
  outDb.exec('PRAGMA busy_timeout = 5000');
  const inDb = new Database(path.join(_syncLocalDir, 'inbound.db'), { readonly: true });
  inDb.exec('PRAGMA busy_timeout = 5000');

  interface MessageOutPayload {
    id: string;
    seq: number;
    in_reply_to: null;
    timestamp: string;
    deliver_after: null;
    recurrence: null;
    kind: 'system';
    platform_id: null;
    channel_type: null;
    thread_id: null;
    content: string;
  }

  try {
    let payload: MessageOutPayload;
    outDb.exec('BEGIN IMMEDIATE');
    try {
      const maxOut = (outDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
      const maxIn = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
      const max = Math.max(maxOut, maxIn);
      const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

      payload = {
        id,
        seq: nextSeq,
        in_reply_to: null,
        timestamp: new Date().toISOString(),
        deliver_after: null,
        recurrence: null,
        kind: 'system',
        platform_id: null,
        channel_type: null,
        thread_id: null,
        content: JSON.stringify(content),
      };

      outDb
        .prepare(
          `INSERT INTO messages_out
             (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
           VALUES ($id, $seq, $in_reply_to, $timestamp, $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
        )
        .run({
          $id: payload.id,
          $seq: payload.seq,
          $in_reply_to: payload.in_reply_to,
          $timestamp: payload.timestamp,
          $deliver_after: payload.deliver_after,
          $recurrence: payload.recurrence,
          $kind: payload.kind,
          $platform_id: payload.platform_id,
          $channel_type: payload.channel_type,
          $thread_id: payload.thread_id,
          $content: payload.content,
        });
      outDb.exec('COMMIT');
    } catch (e) {
      outDb.exec('ROLLBACK');
      throw e;
    }

    await pushOverSyncConnection(outDb, 'outbound', payload);
  } finally {
    inDb.close();
    outDb.close();
  }
}

/**
 * Marks a message_id completed in the local processing_ack table (so the
 * agent-runner poll loop skips re-surfacing it) and pushes that completion
 * to the host — host-sweep.ts reads processing_ack to sync messages_in
 * status and to detect stale claims, so this can't stay purely local
 * without risking a spurious "container stuck" restart for a message this
 * CLI already handled.
 */
export async function pushCompletedAck(messageId: string): Promise<void> {
  const outDb = new Database(path.join(_syncLocalDir, 'outbound.db'));
  outDb.exec('PRAGMA busy_timeout = 5000');

  try {
    const statusChanged = new Date().toISOString();
    outDb
      .prepare(
        "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', ?)",
      )
      .run(messageId, statusChanged);

    await pushOverSyncConnection(outDb, 'ack', { message_id: messageId, status: 'completed', status_changed: statusChanged });
  } finally {
    outDb.close();
  }
}

/** Local (never host-mounted) inbound.db path — where the host's synced responses land, applied by the persistent agent-runner client. */
export function localInboundPath(): string {
  return path.join(_syncLocalDir, 'inbound.db');
}
