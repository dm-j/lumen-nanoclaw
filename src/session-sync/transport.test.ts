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

      expect(onConnect).toHaveBeenCalledWith('sess-onconnect');
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
