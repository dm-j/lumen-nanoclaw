import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clearSyncClient, registerSyncClient } from '../session-sync/active-client.js';
import type { SyncClientHandle } from '../session-sync/client.js';
import { closeSessionDb, initTestSessionDb } from './connection.js';
import { writeMessageOut } from './messages-out.js';

function fakeSyncClient(): SyncClientHandle & { pushed: unknown[] } {
  const pushed: unknown[] = [];
  return {
    pushed,
    handler: () => {},
    attach: () => {},
    pushOutbound: (payload: unknown) => {
      pushed.push(payload);
      return Promise.resolve();
    },
    pushAck: () => Promise.resolve(),
    pushSessionState: () => Promise.resolve(),
    pushContainerState: () => Promise.resolve(),
    drain: () => Promise.resolve({ pending: 0 }),
  };
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  clearSyncClient();
});

describe('writeMessageOut — dual-write to a registered sync client', () => {
  test('pushes the written row via pushOutbound', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    writeMessageOut({ id: 'm1', kind: 'chat', content: 'hi' });

    expect(client.pushed).toHaveLength(1);
    expect(client.pushed[0]).toMatchObject({ id: 'm1', kind: 'chat', content: 'hi' });
  });

  test('no registered client — local write still succeeds', () => {
    expect(() => writeMessageOut({ id: 'm1', kind: 'chat', content: 'hi' })).not.toThrow();
  });
});
