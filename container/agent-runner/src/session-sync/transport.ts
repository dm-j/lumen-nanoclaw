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
 * or a plaintext fallback.
 *
 * `ca`/`rejectUnauthorized` passed directly as top-level `WebSocket`
 * constructor options are silently ignored under Bun's `ws` implementation
 * — confirmed empirically (a real canary flip against a live container hit
 * this: every connection failed the TLS handshake, `rejectUnauthorized`
 * true or false, matching SAN or not — the options just weren't reaching
 * the socket). Wrapping them in an `https.Agent` and passing that as
 * `agent` instead is what actually works under Bun. This is the real fix,
 * not the SAN-mismatch theory that was chased first (see cert.ts's SAN
 * list, which stays generous but is no longer load-bearing for this).
 *
 * Channel-agnostic: connects, authenticates via the signed token the host
 * hands the container at spawn time, and routes `{channel, body}` envelopes
 * to registered handlers. Sync-specific behavior (chain state, resync,
 * writing into the container's local inbound.db) is a separate module, not
 * yet built (see docs/session-sync-transport.md — Phase 2).
 */
import { Agent } from 'https';
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

/**
 * Mirror of the host's HEARTBEAT_CHANNEL constant — must match exactly.
 * App-level, not native WebSocket ping/pong frames: an earlier version
 * relied on the `ws` library's automatic pong response to the host's
 * ws.ping(), which answered reliably on the first cycle after every
 * (re)connect but then went unanswered on the very next cycle, every
 * single time — pointing at a Bun-vs-Node gap in this package's ping/pong
 * frame handling (this file's own header already documents a different
 * Bun `ws` quirk: TLS options silently ignored unless wrapped in an
 * https.Agent). Handling ping/pong as ordinary envelopes routes it through
 * the exact same send/receive path as every other message, so it can't
 * depend on whatever was dropping the frame-level pong.
 */
const HEARTBEAT_CHANNEL = 'session-sync-heartbeat';

interface HeartbeatPing {
  type: 'ping';
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
 *
 * `checkServerIdentity` is overridden to skip hostname verification
 * entirely — deliberately, not a bypass of the real check. The cert is
 * still fully validated against `pinnedCertPem` as the sole CA
 * (`rejectUnauthorized: true` enforces that); only the *hostname-matches-
 * SAN* step is skipped. That step can't generalize: the address a
 * container reaches the host through varies by deployment (Docker
 * Desktop's `host.docker.internal`, a Linux gateway IP via
 * `hostGatewayArgs()`, or a real network address for a remote agent — see
 * docs/roadmap/container-runner-interface.md's "Raspberry Pi on a rover"
 * direction) and can't be baked into the cert's SAN list in advance. Since
 * CA pinning alone already means only this exact cert (backed by a private
 * key that never leaves the host) can complete the handshake, hostname
 * verification adds no additional security here — it only adds a
 * maintenance burden of enumerating every possible connecting address.
 */
export function connectSyncClient(
  url: string,
  token: string,
  pinnedCertPem: string,
  handlers: Record<string, ChannelHandler>,
): Promise<SyncClient> {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ ca: [pinnedCertPem], rejectUnauthorized: true, checkServerIdentity: () => undefined });
    const ws = new WebSocket(url, token, { agent });
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
      if (envelope.channel === HEARTBEAT_CHANNEL) {
        const ping = envelope.body as HeartbeatPing;
        if (ping?.type === 'ping') {
          ws.send(JSON.stringify({ channel: HEARTBEAT_CHANNEL, body: { type: 'pong' } } satisfies Envelope));
        }
        return;
      }
      const handler = handlers[envelope.channel];
      if (handler) handler(envelope.body);
    });
  });
}
