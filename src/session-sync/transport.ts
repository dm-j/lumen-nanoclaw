/**
 * Generic wss:// connection layer for session-sync. No plain ws:// path
 * exists — see docs/session-sync-transport.md §4. Channel-agnostic: knows
 * about auth tokens and envelope routing, nothing about sync semantics.
 * Sync-specific handling (chain verify, resync, DB writes) lives in
 * server.ts, registered here as a channel handler.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'https';
import { WebSocketServer, type WebSocket } from 'ws';

import { getInstallCert } from './cert.js';
import { log } from '../log.js';

export interface Envelope {
  channel: string;
  body: unknown;
}

export type ChannelHandler = (sessionId: string, ws: WebSocket, body: unknown) => void;

/**
 * Reserved channel for token refresh — separate from 'session-sync' so
 * auth/connection lifecycle never mixes into sync-semantic message handling
 * (same separation of concerns as §4.4 in docs/session-sync-transport.md).
 */
export const AUTH_CHANNEL = 'session-sync-auth';

/**
 * Reserved channel for the app-level heartbeat (see HEARTBEAT_INTERVAL_MS's
 * doc comment for why this exists instead of native WebSocket ping/pong
 * frames).
 */
export const HEARTBEAT_CHANNEL = 'session-sync-heartbeat';

export interface HeartbeatPing {
  type: 'ping';
}

export interface HeartbeatPong {
  type: 'pong';
}

/**
 * Header a client sends to mark itself as a short-lived, send-and-ack-only
 * connection — the pattern used by the container's `host-shim`/`ncl` CLI
 * subprocesses (container/agent-runner/src/cli/sync-outbound-push.ts),
 * which open a fresh connection per invocation just to push one outbound
 * row and immediately close. Every session also has exactly one *persistent*
 * connection (the main agent-runner process, container/agent-runner/src/
 * session-sync/startup.ts) that stays open for the container's lifetime and
 * is the only one that should ever occupy `connections` — that map exists
 * solely so pushInboundRow (server.ts) can deliver host-initiated pushes
 * (recall/remember/etc. responses, destinations, session_routing) to a live
 * socket. A transient connection never receives inbound pushes over itself
 * (its response arrives later, asynchronously, over the persistent
 * connection's own socket and gets applied to the container's local
 * inbound.db — see apply-inbound.ts) — so it has no business being tracked
 * there. Before this existed, `connections.set(sessionId, ws)` ran
 * unconditionally on every handshake: a transient connection would clobber
 * the persistent one's slot, and closing (per its own normal lifecycle,
 * seconds later) would delete that slot entirely — leaving the still-open
 * persistent connection silently untracked and every subsequent
 * pushInboundRow call finding "no connection" for a session that was, in
 * fact, fully connected.
 */
const TRANSIENT_CONNECTION_HEADER = 'x-session-sync-role';

/** Token lifetime — opening bid, short enough to bound a leaked-token impersonation window. Refresh happens at half this via AUTH_CHANNEL. */
export const SESSION_SYNC_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface TokenRefresh {
  type: 'token_refresh';
  token: string;
}

/** HMAC-signed token: `<sessionId>.<expiryMs>.<hex signature>`. */
export function signToken(sessionId: string, secret: string, ttlMs: number): string {
  const expiry = Date.now() + ttlMs;
  const payload = `${sessionId}.${expiry}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** Verifies a token; returns the sessionId on success, null on bad/expired/forged token. */
export function verifyToken(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!sessionId || !Number.isFinite(expiry) || Date.now() > expiry) return null;
  const expectedSig = createHmac('sha256', secret).update(`${sessionId}.${expiryStr}`).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

export interface SyncServer {
  httpsServer: HttpsServer;
  wss: WebSocketServer;
  /** Currently-connected sessions: sessionId -> socket. */
  connections: Map<string, WebSocket>;
  close(): Promise<void>;
}

/**
 * Ping cadence for dead-peer detection. A half-open connection (Docker
 * network blip, NAT/idle-timeout drop) can leave a socket in `connections`
 * that looks live — no 'close' event ever fires — while ws.send() on it
 * silently goes nowhere and any pushInboundRow waiting on its ack hangs
 * forever. Without this, recovery depends on the OS's own TCP-level dead-
 * peer detection, which can take far longer than a container's own
 * host-shim call timeout (210s — see container/agent-runner/src/cli/
 * host-shim.ts). Terminating a socket that missed a pong forces 'close',
 * which the client observes as an abrupt disconnect and reconnects from
 * (see agent-runner's session-sync/startup.ts) — and replayPendingInbound
 * (server.ts, wired via index.ts's onConnect) resends anything still
 * in-flight once it does.
 *
 * Deliberately app-level (a HEARTBEAT_CHANNEL envelope), not native
 * WebSocket ping/pong control frames. An earlier version used ws.ping()/
 * ws.on('pong'), which reliably answered the *first* ping after every
 * (re)connect but then went unanswered on the very next cycle, every time
 * — a consistent, reproducible pattern pointing at the container's Bun
 * `ws` client (container/agent-runner/src/session-sync/transport.ts's file
 * header already documents other Bun-vs-Node `ws` package gaps, e.g. TLS
 * options being silently ignored) rather than random network flakiness.
 * An app-level ping/pong round-trips through the exact same message path
 * every other envelope already uses, so it can't depend on whatever in
 * Bun's frame-level ping handling was dropping the second response.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Starts the wss:// server on `port`. Auth token is read from the
 * `Sec-WebSocket-Protocol` header (`sign Token(sessionId, secret, ttl)`,
 * expected as the subprotocol value) — verified on upgrade, before any
 * channel handler runs.
 *
 * While connected, each session gets a fresh token pushed over
 * `AUTH_CHANNEL` at `tokenTtlMs / 2` — well before the current token
 * expires, so a reconnect (network blip, host restart) always has a live
 * token to hand rather than requiring a full container respawn to get a
 * new one. The client mirror (container-side transport.ts) tracks the
 * latest pushed token for exactly that purpose.
 */
export function createSyncServer(
  port: number,
  secret: string,
  tokenTtlMs: number,
  handlers: Record<string, ChannelHandler>,
  onConnect?: (sessionId: string, ws: WebSocket) => void,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
): SyncServer {
  const { cert, key } = getInstallCert();
  const httpsServer = createHttpsServer({ cert, key });
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<string, WebSocket>();

  httpsServer.on('upgrade', (req, socket, head) => {
    const token = req.headers['sec-websocket-protocol'];
    const sessionId = typeof token === 'string' ? verifyToken(token, secret) : null;
    if (!sessionId) {
      socket.destroy();
      return;
    }
    const isTransient = req.headers[TRANSIENT_CONNECTION_HEADER] === 'transient';
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Declared before the message handler below (which references it) so
      // a 'pong' arriving on the very first event-loop tick after handshake
      // has something to flip. Only meaningful for persistent connections —
      // transient ones never get pinged, so this just never flips again.
      let isAlive = true;
      const markAlive = (): void => {
        isAlive = true;
      };

      ws.on('message', (raw) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (envelope.channel === HEARTBEAT_CHANNEL) {
          const body = envelope.body as HeartbeatPing | HeartbeatPong;
          if (body?.type === 'pong') markAlive();
          return;
        }
        const handler = handlers[envelope.channel];
        if (handler) handler(sessionId, ws, envelope.body);
      });
      // Required: an unhandled 'error' event on any EventEmitter (ws sockets
      // included) throws and takes the whole host process down with it — a
      // single flaky connection (e.g. send-after-half-close) must not do that.
      ws.on('error', (err) => {
        log.warn('session-sync connection error', { sessionId, isTransient, error: String(err) });
      });
      wss.emit('connection', ws, req);

      // Transient connections (see TRANSIENT_CONNECTION_HEADER) exist only
      // to send one row and receive its ack over their own socket — they
      // never occupy `connections`, never get pinged, never get a token
      // refresh (they're gone in well under the token TTL), and don't need
      // the onConnect backfill (that's for a session's persistent
      // connection, run once per container lifetime).
      if (isTransient) return;

      connections.set(sessionId, ws);
      log.info('session-sync: persistent connection registered', { sessionId, totalConnections: connections.size });

      const refreshTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        sendEnvelope(ws, AUTH_CHANNEL, {
          type: 'token_refresh',
          token: signToken(sessionId, secret, tokenTtlMs),
        } satisfies TokenRefresh);
      }, tokenTtlMs / 2);

      // isAlive flips to false right before each app-level ping; a 'pong'
      // on HEARTBEAT_CHANNEL (handled in the message listener above, client
      // side in agent-runner's session-sync/transport.ts) flips it back. If
      // it's still false when the next tick fires, the peer missed a full
      // interval — terminate.
      const heartbeatTimer = setInterval(() => {
        if (!isAlive) {
          log.warn('session-sync: connection missed heartbeat, terminating', { sessionId });
          ws.terminate();
          return;
        }
        isAlive = false;
        sendEnvelope(ws, HEARTBEAT_CHANNEL, { type: 'ping' } satisfies HeartbeatPing);
      }, heartbeatIntervalMs);

      ws.on('close', () => {
        clearInterval(refreshTimer);
        clearInterval(heartbeatTimer);
        const isCurrent = connections.get(sessionId) === ws;
        if (isCurrent) connections.delete(sessionId);
        log.info('session-sync: persistent connection closed', {
          sessionId,
          wasCurrentEntry: isCurrent,
          totalConnections: connections.size,
        });
      });
      // Fresh connection: the container's local inbound.db (destinations,
      // session_routing) was only ever populated by pushes made *while*
      // connected — anything written at spawn time (before the WS handshake
      // completes) silently no-ops (no live `ws` to push through yet). Push
      // the current snapshot now so a 'sync'-transport container is never
      // stuck with an empty local destination map. See
      // docs/session-sync-transport.md §8.6.
      onConnect?.(sessionId, ws);
    });
  });

  httpsServer.listen(port);

  return {
    httpsServer,
    wss,
    connections,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const ws of connections.values()) ws.terminate();
        wss.close(() => httpsServer.close(() => resolve()));
      });
    },
  };
}

export function sendEnvelope(ws: WebSocket, channel: string, body: unknown): void {
  ws.send(JSON.stringify({ channel, body } satisfies Envelope));
}
