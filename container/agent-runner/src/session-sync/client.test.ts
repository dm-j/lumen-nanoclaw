import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { GENESIS_CHAIN, nextChain } from './protocol.js';
import { createSyncClient } from './client.js';
import type { SyncClient } from './transport.js';

function fakeSyncClient() {
  const sent: unknown[] = [];
  return {
    sent,
    send: (channel: string, body: unknown) => sent.push({ channel, body }),
  } as unknown as SyncClient & { sent: unknown[] };
}

describe('createSyncClient', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('pushes an outbound row and resolves once acked', async () => {
    const client = createSyncClient(getOutboundDb(), () => {});
    const sync = fakeSyncClient();
    client.attach(sync);

    const payload = { id: 'm1', seq: 1 };
    const pushPromise = client.pushOutbound(payload);

    const expectedChain = nextChain(GENESIS_CHAIN, 1, payload);
    expect(sync.sent).toEqual([
      { channel: 'session-sync', body: { seq: 1, kind: 'outbound', chain: expectedChain, payload } },
    ]);

    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;
  });

  it('rejects a pending push when the host answers with a resync_point instead of an ack', async () => {
    const client = createSyncClient(getOutboundDb(), () => {});
    client.attach(fakeSyncClient());

    const pushPromise = client.pushOutbound({ id: 'm1' });
    client.handler({ type: 'resync_point', seq: 0, chain: GENESIS_CHAIN });

    await expect(pushPromise).rejects.toThrow('resync required');
  });

  it('persists outbound chain state across a simulated restart', async () => {
    const db = getOutboundDb();
    const client = createSyncClient(db, () => {});
    const sync = fakeSyncClient();
    client.attach(sync);

    const payload = { id: 'm1' };
    const pushPromise = client.pushOutbound(payload);
    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;

    const row = db.prepare('SELECT outbound_seq, outbound_chain FROM session_sync_state WHERE id = 1').get() as {
      outbound_seq: number;
      outbound_chain: string;
    };
    expect(row.outbound_seq).toBe(1);
    expect(row.outbound_chain).toBe(nextChain(GENESIS_CHAIN, 1, payload));

    // Simulate a fresh container picking the same outbound.db back up.
    const client2 = createSyncClient(db, () => {});
    const sync2 = fakeSyncClient();
    client2.attach(sync2);

    const payload2 = { id: 'm2' };
    const pushPromise2 = client2.pushOutbound(payload2);
    const expectedChain2 = nextChain(row.outbound_chain, 2, payload2);
    expect(sync2.sent).toEqual([
      { channel: 'session-sync', body: { seq: 2, kind: 'outbound', chain: expectedChain2, payload: payload2 } },
    ]);
    client2.handler({ type: 'ack', seq: 2 });
    await pushPromise2;
  });

  it('rejects a push before attach()', async () => {
    const client = createSyncClient(getOutboundDb(), () => {});
    await expect(client.pushOutbound({ id: 'm1' })).rejects.toThrow('not attached');
  });

  it('applies a host-pushed inbound row once chain-verified', () => {
    const applied: unknown[] = [];
    const client = createSyncClient(getOutboundDb(), (payload) => applied.push(payload));

    const payload = { id: 'in-1', content: 'hi' };
    const chain = nextChain(GENESIS_CHAIN, 1, payload);
    client.handler({ seq: 1, kind: 'inbound', chain, payload });

    expect(applied).toEqual([payload]);
  });

  it('drops a host-pushed inbound row with a bad chain instead of applying it', () => {
    const applied: unknown[] = [];
    const client = createSyncClient(getOutboundDb(), (payload) => applied.push(payload));

    client.handler({ seq: 1, kind: 'inbound', chain: 'wrong', payload: { id: 'in-1' } });

    expect(applied).toEqual([]);
  });

  it('drain resolves immediately when nothing is in flight', async () => {
    const client = createSyncClient(getOutboundDb(), () => {});
    const result = await client.drain(1000);
    expect(result).toEqual({ pending: 0 });
  });

  it('drain waits for an in-flight push to be acked', async () => {
    const client = createSyncClient(getOutboundDb(), () => {});
    client.attach(fakeSyncClient());

    const pushPromise = client.pushOutbound({ id: 'm1' });
    const drainPromise = client.drain(1000);

    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;

    expect(await drainPromise).toEqual({ pending: 0 });
  });

  it('drain times out and reports the still-pending count instead of hanging', async () => {
    const client = createSyncClient(getOutboundDb(), () => {});
    client.attach(fakeSyncClient());

    void client.pushOutbound({ id: 'm1' }).catch(() => {});
    const result = await client.drain(50);

    expect(result).toEqual({ pending: 1 });
  });
});
