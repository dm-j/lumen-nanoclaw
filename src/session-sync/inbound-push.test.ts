import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import {
  registerSyncServer,
  clearSyncServer,
  notifyInboundWrite,
  notifyDeliveredWrite,
  notifyDestinationsWrite,
  notifySessionRoutingWrite,
  type InboundRowPayload,
} from './inbound-push.js';
import * as serverModule from './server.js';
import type { SyncServer } from './transport.js';

function makeGroup(id: string, transport: 'file' | 'sync'): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  ensureContainerConfig(id);
  if (transport === 'sync') updateContainerConfigScalars(id, { transport: 'sync' });
}

function fakeSyncServer(connections: Map<string, unknown>): SyncServer {
  return {
    httpsServer: {} as SyncServer['httpsServer'],
    wss: {} as SyncServer['wss'],
    connections: connections as SyncServer['connections'],
    close: () => Promise.resolve(),
  };
}

const row: InboundRowPayload = {
  id: 'm1',
  seq: 2,
  kind: 'chat',
  timestamp: '2026-01-01T00:00:00.000Z',
  status: 'pending',
  process_after: null,
  recurrence: null,
  series_id: 'm1',
  trigger: 1,
  source_session_id: null,
  platform_id: 'p1',
  channel_type: 'test',
  thread_id: null,
  content: '{}',
  on_wake: 0,
};

describe('notifyInboundWrite', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    clearSyncServer();
    vi.restoreAllMocks();
  });

  it('does nothing when no sync server has been registered', () => {
    makeGroup('ag-sync', 'sync');
    const push = vi.spyOn(serverModule, 'pushInboundRow');
    notifyInboundWrite('ag-sync', 'sess-1', row);
    expect(push).not.toHaveBeenCalled();
  });

  it('does nothing for a group on the default file transport', () => {
    makeGroup('ag-file', 'file');
    registerSyncServer(fakeSyncServer(new Map([['sess-1', {}]])));
    const push = vi.spyOn(serverModule, 'pushInboundRow');
    notifyInboundWrite('ag-file', 'sess-1', row);
    expect(push).not.toHaveBeenCalled();
  });

  it('does nothing when the session has no live connection', () => {
    makeGroup('ag-sync', 'sync');
    registerSyncServer(fakeSyncServer(new Map()));
    const push = vi.spyOn(serverModule, 'pushInboundRow');
    notifyInboundWrite('ag-sync', 'sess-1', row);
    expect(push).not.toHaveBeenCalled();
  });

  it('pushes the row when transport is sync and the session is connected', () => {
    makeGroup('ag-sync', 'sync');
    const ws = {};
    registerSyncServer(fakeSyncServer(new Map([['sess-1', ws]])));
    const push = vi.spyOn(serverModule, 'pushInboundRow').mockResolvedValue(undefined);

    notifyInboundWrite('ag-sync', 'sess-1', row);

    expect(push).toHaveBeenCalledWith('sess-1', ws, expect.any(Function), 'inbound', row);
  });

  it('logs instead of throwing when the push rejects', async () => {
    makeGroup('ag-sync', 'sync');
    registerSyncServer(fakeSyncServer(new Map([['sess-1', {}]])));
    vi.spyOn(serverModule, 'pushInboundRow').mockRejectedValue(new Error('resync required'));

    expect(() => notifyInboundWrite('ag-sync', 'sess-1', row)).not.toThrow();
    // Let the rejected promise's .catch() handler run before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('notifyDeliveredWrite / notifyDestinationsWrite / notifySessionRoutingWrite', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    clearSyncServer();
    vi.restoreAllMocks();
  });

  it('pushes a delivered row with kind "delivered"', () => {
    makeGroup('ag-sync', 'sync');
    const ws = {};
    registerSyncServer(fakeSyncServer(new Map([['sess-1', ws]])));
    const push = vi.spyOn(serverModule, 'pushInboundRow').mockResolvedValue(undefined);

    const deliveredRow = {
      message_out_id: 'mo-1',
      platform_message_id: 'pm-1',
      status: 'delivered',
      delivered_at: '2026-01-01T00:00:00.000Z',
    };
    notifyDeliveredWrite('ag-sync', 'sess-1', deliveredRow);

    expect(push).toHaveBeenCalledWith('sess-1', ws, expect.any(Function), 'delivered', deliveredRow);
  });

  it('pushes a destinations array with kind "destinations"', () => {
    makeGroup('ag-sync', 'sync');
    const ws = {};
    registerSyncServer(fakeSyncServer(new Map([['sess-1', ws]])));
    const push = vi.spyOn(serverModule, 'pushInboundRow').mockResolvedValue(undefined);

    const rows = [
      {
        name: 'peer',
        display_name: 'Peer',
        type: 'agent' as const,
        channel_type: null,
        platform_id: null,
        agent_group_id: 'ag-2',
      },
    ];
    notifyDestinationsWrite('ag-sync', 'sess-1', rows);

    expect(push).toHaveBeenCalledWith('sess-1', ws, expect.any(Function), 'destinations', rows);
  });

  it('pushes a routing row with kind "session_routing"', () => {
    makeGroup('ag-sync', 'sync');
    const ws = {};
    registerSyncServer(fakeSyncServer(new Map([['sess-1', ws]])));
    const push = vi.spyOn(serverModule, 'pushInboundRow').mockResolvedValue(undefined);

    const routing = { channel_type: 'slack', platform_id: 'C1', thread_id: null };
    notifySessionRoutingWrite('ag-sync', 'sess-1', routing);

    expect(push).toHaveBeenCalledWith('sess-1', ws, expect.any(Function), 'session_routing', routing);
  });
});
