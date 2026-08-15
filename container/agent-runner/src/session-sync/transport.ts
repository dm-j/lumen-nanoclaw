/**
 * Generic wss:// client connection for session-sync (container side).
 *
 * Mirror of src/session-sync/transport.ts on the host — no shared modules
 * cross the host/container boundary (same convention as protocol.ts).
 * Uses Bun's native `WebSocket` global — no dependency needed on this side.
 *
 * Channel-agnostic: connects, authenticates via the signed token the host
 * hands the container at spawn time, and routes `{channel, body}` envelopes
 * to registered handlers. Sync-specific behavior (chain state, resync,
 * writing into the container's local inbound.db) is a separate module, not
 * yet built (see docs/session-sync-transport.md — Phase 2).
 */

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
 * handed to the container via container.json at spawn time.
 */
export function connectSyncClient(
  url: string,
  token: string,
  handlers: Record<string, ChannelHandler>,
): Promise<SyncClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, token);
    let latestToken = token;

    ws.addEventListener('open', () => {
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

    ws.addEventListener('error', (event) => {
      reject(new Error(`session-sync connect failed: ${String(event)}`));
    });

    ws.addEventListener('message', (event) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(event.data));
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
