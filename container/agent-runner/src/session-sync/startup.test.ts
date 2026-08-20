import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';

// bun:test's mock.module() replaces a module for the rest of the process —
// mock.restore() (used per-test below) only undoes mock() spies, not module
// replacements. Without this, any test file that runs after this one in the
// same `bun test` invocation would silently get these mocks instead of the
// real config.js/transport.js (confirmed empirically: transport.test.ts
// failed only when run alongside this file, never in isolation). Capture
// the real modules before any mock.module() call below, restore them here.
const realConfig = await import('../config.js');
const realTransport = await import('./transport.js');
afterAll(() => {
  mock.module('../config.js', () => realConfig);
  mock.module('./transport.js', () => realTransport);
});

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-startup-'));
  credentialsPath = path.join(dir, '.session-sync.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadSessionSyncCredentials', () => {
  it('returns null for a missing file', async () => {
    const { loadSessionSyncCredentials } = await import('./credentials.js');
    expect(loadSessionSyncCredentials(credentialsPath)).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    fs.writeFileSync(credentialsPath, 'not json');
    const { loadSessionSyncCredentials } = await import('./credentials.js');
    expect(loadSessionSyncCredentials(credentialsPath)).toBeNull();
  });

  it('returns null when a required field is missing', async () => {
    fs.writeFileSync(credentialsPath, JSON.stringify({ url: 'wss://x:1' }));
    const { loadSessionSyncCredentials } = await import('./credentials.js');
    expect(loadSessionSyncCredentials(credentialsPath)).toBeNull();
  });

  it('returns the parsed shape for a valid file', async () => {
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ url: 'wss://host.docker.internal:58636', token: 'a.b.c', pinnedCertPem: 'CERT' }),
    );
    const { loadSessionSyncCredentials } = await import('./credentials.js');
    expect(loadSessionSyncCredentials(credentialsPath)).toEqual({
      url: 'wss://host.docker.internal:58636',
      token: 'a.b.c',
      pinnedCertPem: 'CERT',
    });
  });
});

describe('initSessionSync', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
    mock.restore();
  });

  it('returns null and never touches connectSyncClient when transport is file', async () => {
    mock.module('../config.js', () => ({ getConfig: () => ({ transport: 'file' }) }));
    let connectCalled = false;
    mock.module('./transport.js', () => ({
      connectSyncClient: () => {
        connectCalled = true;
        return Promise.resolve({});
      },
    }));

    const { initSessionSync } = await import(`./startup.js?t=${Date.now()}`);
    const result = await initSessionSync(credentialsPath);
    expect(result).toBeNull();
    expect(connectCalled).toBe(false);
  });

  it('returns null when transport is sync but no credentials file exists', async () => {
    mock.module('../config.js', () => ({ getConfig: () => ({ transport: 'sync' }) }));

    const { initSessionSync } = await import(`./startup.js?t=${Date.now()}`);
    const result = await initSessionSync(credentialsPath);
    expect(result).toBeNull();
  });

  it('returns null when the connection attempt throws', async () => {
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ url: 'wss://host.docker.internal:58636', token: 'a.b.c', pinnedCertPem: 'CERT' }),
    );
    mock.module('../config.js', () => ({ getConfig: () => ({ transport: 'sync' }) }));
    mock.module('./transport.js', () => ({
      connectSyncClient: () => Promise.reject(new Error('connect failed')),
    }));

    const { initSessionSync } = await import(`./startup.js?t=${Date.now()}`);
    const result = await initSessionSync(credentialsPath);
    expect(result).toBeNull();
  });

  it('connects and returns a client handle when everything lines up', async () => {
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ url: 'wss://host.docker.internal:58636', token: 'a.b.c', pinnedCertPem: 'CERT' }),
    );
    mock.module('../config.js', () => ({ getConfig: () => ({ transport: 'sync' }) }));
    const fakeSync = { send: () => {}, currentToken: () => 'a.b.c', ws: { once: () => {} } };
    mock.module('./transport.js', () => ({
      connectSyncClient: (url: string, token: string, cert: string) => {
        expect(url).toBe('wss://host.docker.internal:58636');
        expect(token).toBe('a.b.c');
        expect(cert).toBe('CERT');
        return Promise.resolve(fakeSync);
      },
    }));

    const { initSessionSync } = await import(`./startup.js?t=${Date.now()}`);
    const result = await initSessionSync(credentialsPath);
    expect(result).not.toBeNull();
    expect(typeof result?.pushOutbound).toBe('function');
  });

  it('reconnects with backoff after the socket closes', async () => {
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ url: 'wss://host.docker.internal:58636', token: 'a.b.c', pinnedCertPem: 'CERT' }),
    );
    mock.module('../config.js', () => ({ getConfig: () => ({ transport: 'sync' }) }));

    let connectCount = 0;
    let closeHandler: (() => void) | undefined;
    mock.module('./transport.js', () => ({
      connectSyncClient: (_url: string, token: string) => {
        connectCount++;
        return Promise.resolve({
          send: () => {},
          currentToken: () => token,
          ws: { once: (event: string, cb: () => void) => { if (event === 'close') closeHandler = cb; } },
        });
      },
    }));

    const { initSessionSync } = await import(`./startup.js?t=${Date.now()}`);
    const result = await initSessionSync(credentialsPath);
    expect(result).not.toBeNull();
    expect(connectCount).toBe(1);

    closeHandler?.();
    // Backoff schedule starts at 1000ms — nothing should reconnect before then.
    await new Promise((r) => setTimeout(r, 50));
    expect(connectCount).toBe(1);

    await new Promise((r) => setTimeout(r, 1200));
    expect(connectCount).toBe(2);
  });
});
