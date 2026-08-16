/**
 * Bootstrap: establishes the session-sync connection when this agent group's
 * container.json says transport: 'sync'. A no-op for the default 'file'
 * transport — every group not opted in sees zero behavior change.
 *
 * Scope note (docs/session-sync-transport.md §6): this only proves the
 * connection works end-to-end (host accepts the token, cert pin holds,
 * client.attach succeeds). The bind mounts and every DB read/write call site
 * (poll-loop.ts, mcp-tools send_message/edit_message/add_reaction,
 * session_state, container_state) still talk to the local files exactly as
 * they do under 'file' transport — rerouting them onto this connection is a
 * separate, deliberately deferred piece of work, since flipping the mounts
 * before every write path is rewired would silently drop an opted-in
 * group's agent replies.
 */
import { getConfig } from '../config.js';
import { getOutboundDb } from '../db/connection.js';
import { createSyncClient, type SyncClientHandle } from './client.js';
import { loadSessionSyncCredentials } from './credentials.js';
import { connectSyncClient } from './transport.js';

function log(msg: string): void {
  console.error(`[session-sync] ${msg}`);
}

/**
 * Returns the connected client handle, or null if this group isn't on
 * 'sync' transport, the credentials file is missing/unreadable, or the
 * connection attempt fails. Never throws — a sync failure must not prevent
 * the container from starting; it just runs as if transport were 'file'.
 */
export async function initSessionSync(credentialsPath?: string): Promise<SyncClientHandle | null> {
  const config = getConfig();
  if (config.transport !== 'sync') return null;

  const credentials = loadSessionSyncCredentials(credentialsPath);
  if (!credentials) {
    log('transport is "sync" but no readable credentials file — continuing without a sync connection');
    return null;
  }

  const client = createSyncClient(getOutboundDb(), (payload) => {
    log(`received a host-pushed inbound row before the write-path rewrite lands — dropping: ${JSON.stringify(payload).slice(0, 200)}`);
  });

  try {
    const sync = await connectSyncClient(credentials.url, credentials.token, credentials.pinnedCertPem, {
      'session-sync': client.handler,
    });
    client.attach(sync);
    log(`connected to host session-sync server at ${credentials.url}`);
    return client;
  } catch (err) {
    log(`connection failed — continuing without a sync connection: ${String(err)}`);
    return null;
  }
}
