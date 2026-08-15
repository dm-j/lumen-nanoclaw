/**
 * Generic wss:// client connection for session-sync (container side).
 *
 * Mirror of src/session-sync/transport.ts on the host — no shared modules
 * cross the host/container boundary (same convention as protocol.ts).
 *
 * Uses the `ws` package rather than Bun's native `WebSocket` global: the
 * native client has no TLS options at all (no `ca`, no `rejectUnauthorized`
 * — confirmed against Bun's docs, not assumed), which would force either
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` (accepts *any* server, not just the host)
 * or a plaintext fallback. `ws`'s client passes its options straight through
 * to Node's `https`/`tls` machinery, which Bun implements for compatibility,
 * so `ca` actually pins the connection to the host's own self-signed cert —
 * the one thing this module exists to get right.
 *
 * Channel-agnostic: connects, authenticates via the signed token the host
 * hands the container at spawn time, and routes `{channel, body}` envelopes
 * to registered handlers. Sync-specific behavior (chain state, resync,
 * writing into the container's local inbound.db) is a separate module, not
 * yet built (see docs/session-sync-transport.md — Phase 2).
 */
import { WebSocket } from 'ws';

export interface Envelope {
  channel: string;
  body: unknown;
}

export type ChannelHandler = (body: unknown) => void;

/** Mirror of the host's AUTH_CHANNEL constant — must match exactly. */
const AUTH_CHANNEL = 'session-sync-auth';

interface TokenRefresh {
  type: 'token_refresh';
  token: string;
}

export interface SyncClient {
  ws: WebSocket;
  send(channel: string, body: unknown): void;
  close(): void;
  /**
   * The most recently issued token — the host pushes a fresh one over
   * AUTH_CHANNEL well before the current one expires (see host-side
   * transport.ts). A future reconnect should call connectSyncClient with
   * this instead of the token baked into container.json at spawn time,
   * so a session outliving one token's TTL doesn't require a full respawn
   * to keep syncing.
   */
  currentToken(): string;
}

/**
 * Connects to the host's session-sync server. `token` is the signed token
 * minted host-side (`signToken` in src/session-sync/transport.ts) and
 * `pinnedCertPem` is the host's own cert (`getInstallCert().cert`) — both
 * handed to the container via container.json at spawn time. The connection
 * trusts *only* `pinnedCertPem` (passed as the sole CA), not the system
 * trust store, so a self-signed cert is exactly as safe as a CA-issued one
 * here: nothing else can pose as this host.
 */
export function connectSyncClient(
  url: string,
  token: string,
  pinnedCertPem: string,
  handlers: Record<string, ChannelHandler>,
): Promise<SyncClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, token, { ca: [pinnedCertPem], rejectUnauthorized: true });
    let latestToken = token;

    ws.on('open', () => {
      resolve({
        ws,
        send(channel: string, body: unknown): void {
          ws.send(JSON.stringify({ channel, body } satisfies Envelope));
        },
        close(): void {
          ws.close();
        },
        currentToken(): string {
          return latestToken;
        },
      });
    });

    ws.on('error', (err) => {
      reject(new Error(`session-sync connect failed: ${String(err)}`));
    });

    ws.on('message', (raw) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (envelope.channel === AUTH_CHANNEL) {
        const refresh = envelope.body as TokenRefresh;
        if (refresh?.type === 'token_refresh' && typeof refresh.token === 'string') {
          latestToken = refresh.token;
        }
        return;
      }
      const handler = handlers[envelope.channel];
      if (handler) handler(envelope.body);
    });
  });
}
