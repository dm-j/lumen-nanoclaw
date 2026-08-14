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
 * Starts the wss:// server on `port`. Auth token is read from the
 * `Sec-WebSocket-Protocol` header (`sign Token(sessionId, secret, ttl)`,
 * expected as the subprotocol value) — verified on upgrade, before any
 * channel handler runs.
 */
export function createSyncServer(port: number, secret: string, handlers: Record<string, ChannelHandler>): SyncServer {
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.set(sessionId, ws);
      ws.on('close', () => {
        if (connections.get(sessionId) === ws) connections.delete(sessionId);
      });
      // Required: an unhandled 'error' event on any EventEmitter (ws sockets
      // included) throws and takes the whole host process down with it — a
      // single flaky connection (e.g. send-after-half-close) must not do that.
      ws.on('error', (err) => {
        log.warn('session-sync connection error', { sessionId, error: String(err) });
      });
      ws.on('message', (raw) => {
        let envelope: Envelope;
        try {
          envelope = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const handler = handlers[envelope.channel];
        if (handler) handler(sessionId, ws, envelope.body);
      });
      wss.emit('connection', ws, req);
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
