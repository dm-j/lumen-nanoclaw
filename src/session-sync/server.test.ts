import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from '../db/session-db.js';
import { GENESIS_CHAIN, nextChain } from './protocol.js';
import { clearChainState, makeSessionSyncHandler } from './server.js';

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
});
