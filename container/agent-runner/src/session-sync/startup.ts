/**
 * Bootstrap: establishes the session-sync connection when this agent group's
 * container.json says transport: 'sync'. A no-op for the default 'file'
 * transport — every group not opted in sees zero behavior change.
 *
 * Under 'sync' transport, db/connection.ts redirects inbound.db/outbound.db
 * to a container-local copy (/workspace/.sync-local/) instead of the
 * host-mounted files, and db/*.ts's write helpers dual-write: the local
 * insert plus a push to the host via the connected client (see
 * session-sync/active-client.ts, registered from index.ts right after this
 * function returns). applyInboundRow (below) is the reverse direction: a
 * host-pushed row gets applied into that same local inbound.db copy.
 */
import { getConfig } from '../config.js';
import { getOutboundDb } from '../db/connection.js';
import { applyInboundRow } from './apply-inbound.js';
import { createSyncClient, type SyncClientHandle } from './client.js';
import { loadSessionSyncCredentials } from './credentials.js';
import { connectSyncClient } from './transport.js';

function log(msg: string): void {
  console.error(`[session-sync] ${msg}`);
}

/** Backoff schedule for reconnect attempts — caps at 30s so a long host outage doesn't spin. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * Reconnects forever in the background once the initial connection drops,
 * using the freshest token the client has seen (host pushes a new one over
 * AUTH_CHANNEL every tokenTtlMs/2 — see transport.ts) rather than re-reading
 * the credentials file, which only ever holds the spawn-time token. Same
 * `client` handle throughout: its chain state and pending pushes survive a
 * reconnect, only the underlying socket is replaced.
 */
function maintainConnection(
  client: SyncClientHandle,
  url: string,
  pinnedCertPem: string,
  lastToken: string,
  attempt = 0,
): void {
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  setTimeout(() => {
    connectSyncClient(url, lastToken, pinnedCertPem, { 'session-sync': client.handler })
      .then((sync) => {
        client.attach(sync);
        log(`reconnected to host session-sync server at ${url}`);
        sync.ws.once('close', () => maintainConnection(client, url, pinnedCertPem, sync.currentToken(), 0));
      })
      .catch((err) => {
        log(`reconnect attempt failed, retrying: ${String(err)}`);
        maintainConnection(client, url, pinnedCertPem, lastToken, attempt + 1);
      });
  }, delay);
}

/**
 * Returns the connected client handle, or null if this group isn't on
 * 'sync' transport, the credentials file is missing/unreadable, or the
 * connection attempt fails. Never throws — a sync failure must not prevent
 * the container from starting; it just runs as if transport were 'file'.
 *
 * Once connected, a dropped socket (network blip, host restart) triggers an
 * automatic background reconnect with backoff — the caller does not need to
 * poll or retry itself.
 */
export async function initSessionSync(credentialsPath?: string): Promise<SyncClientHandle | null> {
  const config = getConfig();
  if (config.transport !== 'sync') return null;

  const credentials = loadSessionSyncCredentials(credentialsPath);
  if (!credentials) {
    log('transport is "sync" but no readable credentials file — continuing without a sync connection');
    return null;
  }

  const client = createSyncClient(getOutboundDb(), applyInboundRow);

  try {
    const sync = await connectSyncClient(credentials.url, credentials.token, credentials.pinnedCertPem, {
      'session-sync': client.handler,
    });
    client.attach(sync);
    log(`connected to host session-sync server at ${credentials.url}`);
    sync.ws.once('close', () => maintainConnection(client, credentials.url, credentials.pinnedCertPem, sync.currentToken(), 0));
    return client;
  } catch (err) {
    log(`connection failed — continuing without a sync connection: ${String(err)}`);
    return null;
  }
}
