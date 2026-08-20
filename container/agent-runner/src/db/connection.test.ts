import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clearSyncClient, registerSyncClient } from '../session-sync/active-client.js';
import type { SyncClientHandle } from '../session-sync/client.js';
import {
  clearContainerToolInFlight,
  closeSessionDb,
  getInboundDb,
  getOutboundDb,
  setContainerToolInFlight,
  setSyncLocalDirForTest,
  setTransportForTest,
} from './connection.js';

function fakeSyncClient(): SyncClientHandle & { pushed: unknown[] } {
  const pushed: unknown[] = [];
  return {
    pushed,
    handler: () => {},
    attach: () => {},
    pushOutbound: () => Promise.resolve(),
    pushAck: () => Promise.resolve(),
    pushSessionState: () => Promise.resolve(),
    pushContainerState: (payload: unknown) => {
      pushed.push(payload);
      return Promise.resolve();
    },
    drain: () => Promise.resolve({ pending: 0 }),
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-sync-local-'));
  setSyncLocalDirForTest(dir);
});

afterEach(() => {
  closeSessionDb();
  clearSyncClient();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("'sync' transport — local DB path redirection", () => {
  test('getOutboundDb creates and uses the local-sync directory, not /workspace', () => {
    setTransportForTest('sync');

    getOutboundDb();

    expect(fs.existsSync(path.join(dir, 'outbound.db'))).toBe(true);
  });

  test('getInboundDb is writable under sync transport (host never mounts this file)', () => {
    setTransportForTest('sync');

    const db = getInboundDb();
    expect(() =>
      db.exec("INSERT INTO messages_in (id, kind, timestamp, content) VALUES ('m1', 'chat', 'now', '{}')"),
    ).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'inbound.db'))).toBe(true);
  });

  test('local inbound.db has the full mirrored schema, including session_routing', () => {
    setTransportForTest('sync');

    const db = getInboundDb();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (t) => t.name,
      ),
    );
    expect(tables.has('messages_in')).toBe(true);
    expect(tables.has('delivered')).toBe(true);
    expect(tables.has('destinations')).toBe(true);
    expect(tables.has('session_routing')).toBe(true);
  });

});

describe('container_state — dual-write to a registered sync client', () => {
  test('setContainerToolInFlight pushes the row', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    setContainerToolInFlight('Bash', 120_000);

    expect(client.pushed).toHaveLength(1);
    expect(client.pushed[0]).toMatchObject({ current_tool: 'Bash', tool_declared_timeout_ms: 120_000 });
  });

  test('clearContainerToolInFlight pushes nulled-out fields', () => {
    const client = fakeSyncClient();
    setContainerToolInFlight('Bash', null);
    registerSyncClient(client);

    clearContainerToolInFlight();

    expect(client.pushed).toHaveLength(1);
    expect(client.pushed[0]).toMatchObject({
      current_tool: null,
      tool_declared_timeout_ms: null,
      tool_started_at: null,
    });
  });

  test('no registered client — write still succeeds locally, nothing thrown', () => {
    expect(() => setContainerToolInFlight('Bash', null)).not.toThrow();
  });
});
