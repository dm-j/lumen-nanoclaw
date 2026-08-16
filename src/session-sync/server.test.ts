import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from '../db/session-db.js';
import { GENESIS_CHAIN, nextChain } from './protocol.js';
import { clearChainState, makeSessionSyncHandler, pushInboundRow, replayPendingInbound } from './server.js';

function fakeWs() {
  const sent: unknown[] = [];
  return {
    sent,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as import('ws').WebSocket & { sent: unknown[] };
}

describe('makeSessionSyncHandler', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sync-'));
    dbPath = path.join(dir, 'outbound.db');
    ensureSchema(dbPath, 'outbound');
    clearChainState('sess-1');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies a valid outbound message and acks', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const ws = fakeWs();
    const payload = {
      id: 'm1',
      seq: 1,
      in_reply_to: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      deliver_after: null,
      recurrence: null,
      kind: 'chat',
      platform_id: 'p1',
      channel_type: 'test',
      thread_id: null,
      content: '{}',
    };
    const chain = nextChain(GENESIS_CHAIN, 1, payload);
    handler('sess-1', ws, { seq: 1, kind: 'outbound', chain, payload });

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM messages_out WHERE id = ?').get('m1');
    db.close();
    expect(row).toBeTruthy();
    expect(ws.sent).toEqual([{ channel: 'session-sync', body: { type: 'ack', seq: 1 } }]);
  });

  it('rejects a bad chain and returns a resync point instead of applying', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const ws = fakeWs();
    const payload = { id: 'm1', seq: 1 };
    handler('sess-1', ws, { seq: 1, kind: 'outbound', chain: 'wrong-chain', payload });

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM messages_out WHERE id = ?').get('m1');
    db.close();
    expect(row).toBeUndefined();
    expect(ws.sent).toEqual([
      { channel: 'session-sync', body: { type: 'resync_point', seq: 0, chain: GENESIS_CHAIN } },
    ]);
  });

  it('answers a resync_request with the current chain position', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const ws = fakeWs();
    handler('sess-1', ws, { type: 'resync_request' });
    expect(ws.sent).toEqual([
      { channel: 'session-sync', body: { type: 'resync_point', seq: 0, chain: GENESIS_CHAIN } },
    ]);
  });

  it('re-derives chain state from outbound.db after a simulated restart instead of resetting to genesis', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const ws = fakeWs();
    const payload = {
      id: 'm1',
      seq: 1,
      in_reply_to: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      deliver_after: null,
      recurrence: null,
      kind: 'chat',
      platform_id: 'p1',
      channel_type: 'test',
      thread_id: null,
      content: '{}',
    };
    const chain = nextChain(GENESIS_CHAIN, 1, payload);
    handler('sess-1', ws, { seq: 1, kind: 'outbound', chain, payload });

    // Simulate a host restart: drop the in-memory cache only.
    clearChainState('sess-1');

    const ws2 = fakeWs();
    handler('sess-1', ws2, { type: 'resync_request' });
    expect(ws2.sent).toEqual([{ channel: 'session-sync', body: { type: 'resync_point', seq: 1, chain } }]);
  });

  it('applies a synced session_state row (Chat SDK resumption data)', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const ws = fakeWs();
    const payload = { key: 'chat_sdk_session_id', value: 'sdk-abc123', updated_at: '2026-01-01T00:00:00.000Z' };
    const chain = nextChain(GENESIS_CHAIN, 1, payload);
    handler('sess-1', ws, { seq: 1, kind: 'session_state', chain, payload });

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get('chat_sdk_session_id') as
      | { value: string }
      | undefined;
    db.close();
    expect(row?.value).toBe('sdk-abc123');
  });

  it('upserts a synced session_state row on a repeat key', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const first = { key: 'k', value: 'v1', updated_at: '2026-01-01T00:00:00.000Z' };
    const chain1 = nextChain(GENESIS_CHAIN, 1, first);
    handler('sess-1', fakeWs(), { seq: 1, kind: 'session_state', chain: chain1, payload: first });

    const second = { key: 'k', value: 'v2', updated_at: '2026-01-01T00:00:01.000Z' };
    const chain2 = nextChain(chain1, 3, second);
    handler('sess-1', fakeWs(), { seq: 3, kind: 'session_state', chain: chain2, payload: second });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT value FROM session_state WHERE key = ?').all('k');
    db.close();
    expect(rows).toEqual([{ value: 'v2' }]);
  });

  it('deletes a session_state row when the pushed value is null (deleteValue signal)', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const first = { key: 'k', value: 'v1', updated_at: '2026-01-01T00:00:00.000Z' };
    const chain1 = nextChain(GENESIS_CHAIN, 1, first);
    handler('sess-1', fakeWs(), { seq: 1, kind: 'session_state', chain: chain1, payload: first });

    const deletion = { key: 'k', value: null, updated_at: '2026-01-01T00:00:01.000Z' };
    const chain2 = nextChain(chain1, 3, deletion);
    handler('sess-1', fakeWs(), { seq: 3, kind: 'session_state', chain: chain2, payload: deletion });

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get('k');
    db.close();
    expect(row).toBeUndefined();
  });

  it('applies a synced container_state row (stuck-tool sweep window)', () => {
    const handler = makeSessionSyncHandler(() => dbPath);
    const ws = fakeWs();
    const payload = {
      current_tool: 'Bash',
      tool_declared_timeout_ms: 120_000,
      tool_started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const chain = nextChain(GENESIS_CHAIN, 1, payload);
    handler('sess-1', ws, { seq: 1, kind: 'container_state', chain, payload });

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state WHERE id = 1').get() as
      | { current_tool: string; tool_declared_timeout_ms: number }
      | undefined;
    db.close();
    expect(row).toEqual({ current_tool: 'Bash', tool_declared_timeout_ms: 120_000 });
  });

  describe('pushInboundRow', () => {
    it('resolves once the container replies with an ack', async () => {
      const handler = makeSessionSyncHandler(() => dbPath);
      const ws = fakeWs();
      const payload = { id: 'in-1', content: 'hi' };
      const pushPromise = pushInboundRow('sess-1', ws, () => dbPath, 'inbound', payload);

      expect(ws.sent).toEqual([
        {
          channel: 'session-sync',
          body: { seq: 1, kind: 'inbound', chain: nextChain(GENESIS_CHAIN, 1, payload), payload },
        },
      ]);

      // Simulate the container's ack coming back in on the same handler.
      handler('sess-1', ws, { type: 'ack', seq: 1 });
      await pushPromise;

      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT inbound_seq, inbound_chain FROM session_sync_state WHERE id = 1').get() as {
        inbound_seq: number;
        inbound_chain: string;
      };
      db.close();
      expect(row.inbound_seq).toBe(1);
    });

    it('replays from the log when the container reports a resync_point instead of acking', async () => {
      const handler = makeSessionSyncHandler(() => dbPath);
      const ws = fakeWs();
      const pushPromise = pushInboundRow('sess-1', ws, () => dbPath, 'inbound', { id: 'in-1' });
      const firstSend = ws.sent[0];

      handler('sess-1', ws, { type: 'resync_point', seq: 0, chain: GENESIS_CHAIN });

      // Replay resends the exact same seq/chain/payload from session_sync_log.
      expect(ws.sent[ws.sent.length - 1]).toEqual(firstSend);

      handler('sess-1', ws, { type: 'ack', seq: 1 });
      await expect(pushPromise).resolves.toBeUndefined();
    });

    it('replayPendingInbound resends unacked pushes over a reconnected socket, and does not resend already-acked ones', async () => {
      const handler = makeSessionSyncHandler(() => dbPath);
      const oldWs = fakeWs();

      const p1 = pushInboundRow('sess-1', oldWs, () => dbPath, 'inbound', { id: 'in-1' });
      handler('sess-1', oldWs, { type: 'ack', seq: 1 });
      await p1;

      // in-2 sent but never acked before the (simulated) disconnect.
      const p2 = pushInboundRow('sess-1', oldWs, () => dbPath, 'inbound', { id: 'in-2' });

      const newWs = fakeWs();
      replayPendingInbound('sess-1', newWs, () => dbPath);

      expect(newWs.sent).toEqual([
        {
          channel: 'session-sync',
          body: { seq: 2, kind: 'inbound', chain: expect.any(String), payload: { id: 'in-2' } },
        },
      ]);

      handler('sess-1', newWs, { type: 'ack', seq: 2 });
      await expect(p2).resolves.toBeUndefined();
    });

    it('replayPendingInbound is a no-op when nothing is pending', () => {
      const newWs = fakeWs();
      replayPendingInbound('sess-1', newWs, () => dbPath);
      expect(newWs.sent).toEqual([]);
    });

    it('advances the inbound seq across successive pushes', async () => {
      const handler = makeSessionSyncHandler(() => dbPath);
      const ws = fakeWs();

      const p1 = pushInboundRow('sess-1', ws, () => dbPath, 'inbound', { id: 'in-1' });
      handler('sess-1', ws, { type: 'ack', seq: 1 });
      await p1;

      const p2 = pushInboundRow('sess-1', ws, () => dbPath, 'inbound', { id: 'in-2' });
      expect(ws.sent[1]).toMatchObject({ channel: 'session-sync', body: { seq: 2, kind: 'inbound' } });
      handler('sess-1', ws, { type: 'ack', seq: 2 });
      await p2;
    });

    it('assigns distinct seqs to two pushes fired in the same tick, before either is acked', async () => {
      const handler = makeSessionSyncHandler(() => dbPath);
      const ws = fakeWs();

      // Mirrors delivery.ts's undelivered-message loop: two pushInboundRow
      // calls back to back, neither awaited before the next fires.
      const p1 = pushInboundRow('sess-1', ws, () => dbPath, 'delivered', { id: 'd-1' });
      const p2 = pushInboundRow('sess-1', ws, () => dbPath, 'delivered', { id: 'd-2' });

      expect(ws.sent[0]).toMatchObject({ channel: 'session-sync', body: { seq: 1 } });
      expect(ws.sent[1]).toMatchObject({ channel: 'session-sync', body: { seq: 2 } });

      handler('sess-1', ws, { type: 'ack', seq: 1 });
      handler('sess-1', ws, { type: 'ack', seq: 2 });
      await Promise.all([p1, p2]);
    });
  });
});
