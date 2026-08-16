/**
 * Applies a host-pushed inbound-direction row into the container's local
 * inbound.db (writable under 'sync' transport — see db/connection.ts's path
 * redirection). One function per SyncMessageKind on the inbound side,
 * dispatched by applyInboundRow(). Mirrors the shape of the host's own
 * writers (src/db/session-db.ts's insertMessage/markDelivered/
 * replaceDestinations/upsertSessionRouting) without importing them —
 * no shared modules cross the host/container boundary.
 */
import { getInboundDb } from '../db/connection.js';
import type { SyncMessageKind } from './protocol.js';

interface InboundRowPayload {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  trigger: 0 | 1;
  source_session_id: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  on_wake: 0 | 1;
}

function applyMessageIn(row: InboundRowPayload): void {
  getInboundDb()
    .prepare(
      `INSERT OR IGNORE INTO messages_in
         (id, seq, kind, timestamp, status, process_after, recurrence, series_id, trigger, source_session_id, platform_id, channel_type, thread_id, content, on_wake)
       VALUES
         ($id, $seq, $kind, $timestamp, $status, $process_after, $recurrence, $series_id, $trigger, $source_session_id, $platform_id, $channel_type, $thread_id, $content, $on_wake)`,
    )
    .run({
      $id: row.id,
      $seq: row.seq,
      $kind: row.kind,
      $timestamp: row.timestamp,
      $status: row.status,
      $process_after: row.process_after,
      $recurrence: row.recurrence,
      $series_id: row.series_id,
      $trigger: row.trigger,
      $source_session_id: row.source_session_id,
      $platform_id: row.platform_id,
      $channel_type: row.channel_type,
      $thread_id: row.thread_id,
      $content: row.content,
      $on_wake: row.on_wake,
    });
}

interface DeliveredPayload {
  message_out_id: string;
  platform_message_id: string | null;
  status: string;
  delivered_at: string;
}

function applyDelivered(row: DeliveredPayload): void {
  getInboundDb()
    .prepare(
      `INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at)
       VALUES ($message_out_id, $platform_message_id, $status, $delivered_at)`,
    )
    .run({
      $message_out_id: row.message_out_id,
      $platform_message_id: row.platform_message_id,
      $status: row.status,
      $delivered_at: row.delivered_at,
    });
}

interface DestinationsPayload {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function applyDestinations(rows: DestinationsPayload[]): void {
  const db = getInboundDb();
  const stmt = db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ($name, $display_name, $type, $channel_type, $platform_id, $agent_group_id)`,
  );
  db.transaction(() => {
    db.exec('DELETE FROM destinations');
    for (const row of rows) {
      stmt.run({
        $name: row.name,
        $display_name: row.display_name,
        $type: row.type,
        $channel_type: row.channel_type,
        $platform_id: row.platform_id,
        $agent_group_id: row.agent_group_id,
      });
    }
  })();
}

interface SessionRoutingPayload {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

function applySessionRouting(row: SessionRoutingPayload): void {
  getInboundDb()
    .prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, $channel_type, $platform_id, $thread_id)
       ON CONFLICT(id) DO UPDATE SET
         channel_type = excluded.channel_type,
         platform_id  = excluded.platform_id,
         thread_id    = excluded.thread_id`,
    )
    .run({ $channel_type: row.channel_type, $platform_id: row.platform_id, $thread_id: row.thread_id });
}

/** Dispatches a host-pushed inbound-direction row to the right local table by kind. Unknown kinds are logged and dropped. */
export function applyInboundRow(kind: SyncMessageKind, payload: unknown): void {
  switch (kind) {
    case 'inbound':
      applyMessageIn(payload as InboundRowPayload);
      return;
    case 'delivered':
      applyDelivered(payload as DeliveredPayload);
      return;
    case 'destinations':
      applyDestinations(payload as DestinationsPayload[]);
      return;
    case 'session_routing':
      applySessionRouting(payload as SessionRoutingPayload);
      return;
    default:
      console.error(`[session-sync] applyInboundRow: unexpected kind "${kind}" — dropping`);
  }
}
