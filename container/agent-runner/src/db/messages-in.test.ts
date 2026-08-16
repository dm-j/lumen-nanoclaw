import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clearSyncClient, registerSyncClient } from '../session-sync/active-client.js';
import type { SyncClientHandle } from '../session-sync/client.js';
import { closeSessionDb, initTestSessionDb } from './connection.js';
import { markCompleted, markFailed, markProcessing, markScriptSkipped } from './messages-in.js';

function fakeSyncClient(): SyncClientHandle & { pushed: unknown[] } {
  const pushed: unknown[] = [];
  return {
    pushed,
    handler: () => {},
    attach: () => {},
    pushOutbound: () => Promise.resolve(),
    pushAck: (payload: unknown) => {
      pushed.push(payload);
      return Promise.resolve();
    },
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

describe('processing_ack writers — dual-write to a registered sync client', () => {
  test('markProcessing pushes one ack per id', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    markProcessing(['m1', 'm2']);

    expect(client.pushed).toHaveLength(2);
    expect(client.pushed).toContainEqual(expect.objectContaining({ message_id: 'm1', status: 'processing' }));
    expect(client.pushed).toContainEqual(expect.objectContaining({ message_id: 'm2', status: 'processing' }));
  });

  test('markCompleted pushes status completed', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    markCompleted(['m1']);

    expect(client.pushed[0]).toMatchObject({ message_id: 'm1', status: 'completed' });
  });

  test('markScriptSkipped maps reason to status', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    markScriptSkipped([
      { id: 'm1', reason: 'gated' },
      { id: 'm2', reason: 'error' },
    ]);

    expect(client.pushed).toContainEqual(expect.objectContaining({ message_id: 'm1', status: 'completed' }));
    expect(client.pushed).toContainEqual(expect.objectContaining({ message_id: 'm2', status: 'script-skip:error' }));
  });

  test('markFailed pushes status failed', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    markFailed('m1');

    expect(client.pushed[0]).toMatchObject({ message_id: 'm1', status: 'failed' });
  });

  test('no registered client — local writes still succeed', () => {
    expect(() => markProcessing(['m1'])).not.toThrow();
  });

  test('empty id list is a no-op — no push', () => {
    const client = fakeSyncClient();
    registerSyncClient(client);

    markProcessing([]);

    expect(client.pushed).toHaveLength(0);
  });
});
