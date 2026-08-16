import { beforeEach, afterEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { applyInboundRow } from './apply-inbound.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('applyInboundRow', () => {
  test("'inbound' kind inserts into messages_in", () => {
    applyInboundRow('inbound', {
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
    });

    const row = getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get('m1') as { id: string } | undefined;
    expect(row?.id).toBe('m1');
  });

  test("'inbound' kind is idempotent (INSERT OR IGNORE) — a re-applied row doesn't throw", () => {
    const payload = {
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
    applyInboundRow('inbound', payload);
    expect(() => applyInboundRow('inbound', payload)).not.toThrow();
  });

  test("'delivered' kind inserts into delivered", () => {
    applyInboundRow('delivered', {
      message_out_id: 'mo-1',
      platform_message_id: 'pm-1',
      status: 'delivered',
      delivered_at: '2026-01-01T00:00:00.000Z',
    });

    const row = getInboundDb().prepare('SELECT * FROM delivered WHERE message_out_id = ?').get('mo-1') as
      | { platform_message_id: string }
      | undefined;
    expect(row?.platform_message_id).toBe('pm-1');
  });

  test("'destinations' kind replaces the full table", () => {
    applyInboundRow('destinations', [
      { name: 'peer', display_name: 'Peer', type: 'agent', channel_type: null, platform_id: null, agent_group_id: 'ag-2' },
    ]);
    applyInboundRow('destinations', [
      { name: 'channel-1', display_name: 'Channel', type: 'channel', channel_type: 'slack', platform_id: 'C1', agent_group_id: null },
    ]);

    const rows = getInboundDb().prepare('SELECT name FROM destinations').all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(['channel-1']);
  });

  test("'session_routing' kind upserts the single row", () => {
    applyInboundRow('session_routing', { channel_type: 'slack', platform_id: 'C1', thread_id: null });
    applyInboundRow('session_routing', { channel_type: 'telegram', platform_id: 'T1', thread_id: '42' });

    const row = getInboundDb().prepare('SELECT * FROM session_routing WHERE id = 1').get() as {
      channel_type: string;
      platform_id: string;
      thread_id: string;
    };
    expect(row).toMatchObject({ channel_type: 'telegram', platform_id: 'T1', thread_id: '42' });
  });

  test('unknown kind is dropped, not thrown', () => {
    expect(() => applyInboundRow('ack' as never, {})).not.toThrow();
  });
});
