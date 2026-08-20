import { describe, expect, it, vi } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), `nanoclaw-session-sync-transport-${Date.now()}`) };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { AUTH_CHANNEL, createSyncServer, signToken, verifyToken } = await import('./transport.js');
const { getInstallCert } = await import('./cert.js');

describe('signToken/verifyToken', () => {
  it('round-trips a valid token', () => {
    const token = signToken('sess-1', 'secret-a', 60_000);
    expect(verifyToken(token, 'secret-a')).toBe('sess-1');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken('sess-1', 'secret-a', 60_000);
    expect(verifyToken(token, 'secret-b')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signToken('sess-1', 'secret-a', -1);
    expect(verifyToken(token, 'secret-a')).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyToken('not.a.valid.token', 'secret-a')).toBeNull();
    expect(verifyToken('garbage', 'secret-a')).toBeNull();
  });

  it('rejects a tampered sessionId', () => {
    const token = signToken('sess-1', 'secret-a', 60_000);
    const [, expiry, sig] = token.split('.');
    expect(verifyToken(`sess-evil.${expiry}.${sig}`, 'secret-a')).toBeNull();
  });
});

describe('createSyncServer token refresh', () => {
  it('pushes a fresh, valid token over AUTH_CHANNEL before the current one expires', async () => {
    const secret = 'refresh-secret';
    const ttlMs = 100; // refresh fires at ttlMs / 2 = 50ms
    const server = createSyncServer(0, secret, ttlMs, {});
    const port = (server.httpsServer.address() as { port: number }).port;
    const initialToken = signToken('sess-refresh', secret, ttlMs);

    const client = new NodeWebSocket(`wss://127.0.0.1:${port}`, initialToken, { rejectUnauthorized: false });

    try {
      const refreshed = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('no refresh received in time')), 2000);
        client.on('message', (raw) => {
          const envelope = JSON.parse(raw.toString());
          if (envelope.channel === AUTH_CHANNEL && envelope.body?.type === 'token_refresh') {
            clearTimeout(timeout);
            resolve(envelope.body.token);
          }
        });
        client.on('error', reject);
      });

      expect(refreshed).not.toBe(initialToken);
      expect(verifyToken(refreshed, secret)).toBe('sess-refresh');
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe('createSyncServer onConnect', () => {
  it('fires with the sessionId once the WS handshake completes, so the caller can backfill destinations/session_routing', async () => {
    const secret = 'onconnect-secret';
    const onConnect = vi.fn();
    const server = createSyncServer(0, secret, 60_000, {}, onConnect);
    const port = (server.httpsServer.address() as { port: number }).port;
    const token = signToken('sess-onconnect', secret, 60_000);

    const client = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, { rejectUnauthorized: false });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('no open event received in time')), 2000);
        client.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        client.on('error', reject);
      });

      expect(onConnect).toHaveBeenCalledWith('sess-onconnect', expect.anything());
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe('transient connections (x-session-sync-role header)', () => {
  it("never registers in `connections`, and doesn't evict a persistent connection's slot on close", async () => {
    const secret = 'transient-secret';
    const server = createSyncServer(0, secret, 60_000, {});
    const port = (server.httpsServer.address() as { port: number }).port;
    const token = signToken('sess-transient', secret, 60_000);

    const persistent = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, { rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('persistent connection did not open in time')), 2000);
      persistent.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      persistent.on('error', reject);
    });
    const persistentServerSideWs = server.connections.get('sess-transient');
    expect(persistentServerSideWs).toBeDefined();

    const transient = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, {
      rejectUnauthorized: false,
      headers: { 'x-session-sync-role': 'transient' },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('transient connection did not open in time')), 2000);
      transient.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      transient.on('error', reject);
    });

    // The transient connection must not have clobbered the persistent one's slot.
    expect(server.connections.get('sess-transient')).toBe(persistentServerSideWs);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('transient connection did not close in time')), 2000);
      transient.on('close', () => {
        clearTimeout(timeout);
        setTimeout(resolve, 20);
      });
      transient.close();
    });

    // Closing the transient connection must not have evicted the still-open
    // persistent one — this is the exact bug: a short-lived CLI push
    // connection closing and deleting the map entry out from under a fully
    // live persistent connection.
    expect(server.connections.get('sess-transient')).toBe(persistentServerSideWs);

    persistent.close();
    await server.close();
  });
});

describe('createSyncServer heartbeat', () => {
  it('keeps a responsive connection alive across multiple ping cycles', async () => {
    const secret = 'heartbeat-secret';
    const server = createSyncServer(0, secret, 60_000, {}, undefined, 15);
    const port = (server.httpsServer.address() as { port: number }).port;
    const token = signToken('sess-heartbeat-alive', secret, 60_000);
    const client = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, { rejectUnauthorized: false });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('no open event received in time')), 2000);
        client.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        client.on('error', reject);
      });

      // Heartbeat is app-level (HEARTBEAT_CHANNEL envelopes, not native
      // ping/pong frames — see transport.ts's doc comment), so a responsive
      // client here means one that answers that envelope, not one that
      // relies on the WebSocket library's frame-level auto-pong.
      client.on('message', (raw) => {
        const envelope = JSON.parse(raw.toString());
        if (envelope.channel === 'session-sync-heartbeat' && envelope.body?.type === 'ping') {
          client.send(JSON.stringify({ channel: 'session-sync-heartbeat', body: { type: 'pong' } }));
        }
      });

      // Give the server several ping intervals to prove it doesn't
      // terminate a peer that's responding.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(server.connections.get('sess-heartbeat-alive')).toBeDefined();
      expect(client.readyState).toBe(client.OPEN);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('terminates and cleans up a connection that stops responding to pings', async () => {
    const secret = 'heartbeat-secret';
    const server = createSyncServer(0, secret, 60_000, {}, undefined, 15);
    const port = (server.httpsServer.address() as { port: number }).port;
    const token = signToken('sess-heartbeat-dead', secret, 60_000);
    const client = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, { rejectUnauthorized: false });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('no open event received in time')), 2000);
        client.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        client.on('error', reject);
      });

      // Simulate a half-open connection: this client never answers the
      // app-level ping (HEARTBEAT_CHANNEL), same as a Docker network blip
      // that never sends a close frame — no monkey-patching needed since
      // heartbeat no longer rides native ping/pong frames, which the
      // underlying library would auto-answer regardless of app code.

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('connection was not terminated in time')), 2000);
        client.on('close', () => {
          clearTimeout(timeout);
          // The client's own 'close' and the server-side ws's 'close' (which
          // is what actually runs connections.delete) fire independently —
          // give the server's handler a tick to run before asserting.
          setTimeout(resolve, 20);
        });
      });

      expect(server.connections.get('sess-heartbeat-dead')).toBeUndefined();
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe('cert pinning (mirrors how the container client trusts the host)', () => {
  it("connects when the client pins the host's actual cert as its sole CA", async () => {
    const server = createSyncServer(0, 'pin-secret', 60_000, {});
    const port = (server.httpsServer.address() as { port: number }).port;
    const token = signToken('sess-pin', 'pin-secret', 60_000);
    const { cert } = getInstallCert();

    try {
      await new Promise<void>((resolve, reject) => {
        const client = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, {
          ca: [cert],
          rejectUnauthorized: true,
        });
        client.on('open', () => {
          client.close();
          resolve();
        });
        client.on('error', reject);
      });
    } finally {
      await server.close();
    }
  });

  it('rejects the connection when the client has no pin for the self-signed cert', async () => {
    const server = createSyncServer(0, 'pin-secret', 60_000, {});
    const port = (server.httpsServer.address() as { port: number }).port;
    const token = signToken('sess-pin', 'pin-secret', 60_000);

    try {
      await expect(
        new Promise<void>((resolve, reject) => {
          // No `ca` pin — full TLS validation against the system trust store,
          // which a self-signed cert always fails. Proves pinning is load-bearing:
          // without it, this connection cannot succeed by accident.
          const client = new NodeWebSocket(`wss://127.0.0.1:${port}`, token, { rejectUnauthorized: true });
          client.on('open', () => {
            client.close();
            resolve();
          });
          client.on('error', reject);
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
