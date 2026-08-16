import fs from 'fs';
import os from 'os';
import path from 'path';

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

const RESYNC_REQUEST = { channel: 'session-sync', body: { type: 'resync_request' } };

describe('createSyncClient', () => {
  let syncLocalDir: string;

  beforeEach(() => {
    initTestSessionDb();
    syncLocalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-client-'));
  });

  afterEach(() => {
    closeSessionDb();
    fs.rmSync(syncLocalDir, { recursive: true, force: true });
  });

  it('pushes an outbound row and resolves once acked', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    const sync = fakeSyncClient();
    client.attach(sync);

    const payload = { id: 'm1', seq: 1 };
    const pushPromise = client.pushOutbound(payload);

    const expectedChain = nextChain(GENESIS_CHAIN, 1, payload);
    expect(sync.sent).toEqual([
      RESYNC_REQUEST,
      { channel: 'session-sync', body: { seq: 1, kind: 'outbound', chain: expectedChain, payload } },
    ]);

    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;
  });

  it('replays the pending push from its local log when the host answers with a resync_point instead of an ack', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    const sync = fakeSyncClient();
    client.attach(sync);

    const payload = { id: 'm1' };
    const pushPromise = client.pushOutbound(payload);
    const expectedChain = nextChain(GENESIS_CHAIN, 1, payload);

    // Host reports it never saw seq 1 (chain mismatch, or just answering
    // attach()'s own resync_request) — client replays from its local log
    // instead of giving up on the pending push.
    client.handler({ type: 'resync_point', seq: 0, chain: GENESIS_CHAIN });

    expect(sync.sent).toEqual([
      RESYNC_REQUEST,
      { channel: 'session-sync', body: { seq: 1, kind: 'outbound', chain: expectedChain, payload } },
      { channel: 'session-sync', body: { seq: 1, kind: 'outbound', chain: expectedChain, payload } },
    ]);

    // The original pushPromise resolves once the replayed send is acked —
    // never rejected, unlike the old give-up behavior.
    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;
  });

  it('does not replay past what the host already has', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    const sync = fakeSyncClient();
    client.attach(sync);

    const payload = { id: 'm1' };
    const pushPromise = client.pushOutbound(payload);
    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;

    sync.sent.length = 0;
    // Host reports it already has seq 1 — nothing in the log past that, so
    // replay is a no-op.
    client.handler({ type: 'resync_point', seq: 1, chain: nextChain(GENESIS_CHAIN, 1, payload) });
    expect(sync.sent).toEqual([]);
  });

  it('persists outbound chain state across a simulated restart', async () => {
    const db = getOutboundDb();
    const client = createSyncClient(db, () => {}, syncLocalDir);
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
    const client2 = createSyncClient(db, () => {}, syncLocalDir);
    const sync2 = fakeSyncClient();
    client2.attach(sync2);

    const payload2 = { id: 'm2' };
    const pushPromise2 = client2.pushOutbound(payload2);
    const expectedChain2 = nextChain(row.outbound_chain, 2, payload2);
    expect(sync2.sent).toEqual([
      RESYNC_REQUEST,
      { channel: 'session-sync', body: { seq: 2, kind: 'outbound', chain: expectedChain2, payload: payload2 } },
    ]);
    client2.handler({ type: 'ack', seq: 2 });
    await pushPromise2;
  });

  it('rejects a push before attach()', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    await expect(client.pushOutbound({ id: 'm1' })).rejects.toThrow('not attached');
  });

  it('assigns distinct seqs to two pushes fired in the same tick, before either is acked', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    const sync = fakeSyncClient();
    client.attach(sync);

    // Mirrors two mcp-tools sends firing back to back, neither awaited
    // before the next call — must not both claim the same next seq.
    const p1 = client.pushOutbound({ id: 'm1' });
    const p2 = client.pushOutbound({ id: 'm2' });

    expect(sync.sent).toEqual([
      RESYNC_REQUEST,
      { channel: 'session-sync', body: { seq: 1, kind: 'outbound', chain: nextChain(GENESIS_CHAIN, 1, { id: 'm1' }), payload: { id: 'm1' } } },
      { channel: 'session-sync', body: { seq: 2, kind: 'outbound', chain: nextChain(nextChain(GENESIS_CHAIN, 1, { id: 'm1' }), 2, { id: 'm2' }), payload: { id: 'm2' } } },
    ]);

    client.handler({ type: 'ack', seq: 1 });
    client.handler({ type: 'ack', seq: 2 });
    await Promise.all([p1, p2]);
  });

  it('applies a host-pushed inbound row once chain-verified', () => {
    const applied: unknown[] = [];
    const client = createSyncClient(getOutboundDb(), (_kind, payload) => applied.push(payload), syncLocalDir);

    const payload = { id: 'in-1', content: 'hi' };
    const chain = nextChain(GENESIS_CHAIN, 1, payload);
    client.handler({ seq: 1, kind: 'inbound', chain, payload });

    expect(applied).toEqual([payload]);
  });

  it('drops a host-pushed inbound row with a bad chain instead of applying it', () => {
    const applied: unknown[] = [];
    const client = createSyncClient(getOutboundDb(), (_kind, payload) => applied.push(payload), syncLocalDir);

    client.handler({ seq: 1, kind: 'inbound', chain: 'wrong', payload: { id: 'in-1' } });

    expect(applied).toEqual([]);
  });

  it('drain resolves immediately when nothing is in flight', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    const result = await client.drain(1000);
    expect(result).toEqual({ pending: 0 });
  });

  it('drain waits for an in-flight push to be acked', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    client.attach(fakeSyncClient());

    const pushPromise = client.pushOutbound({ id: 'm1' });
    const drainPromise = client.drain(1000);

    client.handler({ type: 'ack', seq: 1 });
    await pushPromise;

    expect(await drainPromise).toEqual({ pending: 0 });
  });

  it('drain times out and reports the still-pending count instead of hanging', async () => {
    const client = createSyncClient(getOutboundDb(), () => {}, syncLocalDir);
    client.attach(fakeSyncClient());

    void client.pushOutbound({ id: 'm1' }).catch(() => {});
    const result = await client.drain(50);

    expect(result).toEqual({ pending: 1 });
  });
});
