/**
 * Session DB schemas — container-side mirror of src/db/schema.ts's
 * INBOUND_SCHEMA/OUTBOUND_SCHEMA. No shared modules cross the host/container
 * boundary (same convention as protocol.ts/transport.ts in session-sync/) —
 * keep the two in sync by hand.
 *
 * Only used under 'sync' transport, to create the container's own local
 * copies at /workspace/.sync-local/{inbound,outbound}.db (see connection.ts).
 * Under 'file' transport the host creates both files via ensureSchema
 * (src/db/session-db.ts) and this module is never touched.
 */

/** Local copy of the host-owned inbound tables: messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  source_session_id TEXT,
  on_wake        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,
  channel_type    TEXT,
  platform_id     TEXT,
  agent_group_id  TEXT
);

CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
`;

/** Local copy of the container-owned outbound tables: outbound messages + acks + app state. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_sync_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  outbound_seq   INTEGER NOT NULL DEFAULT 0,
  outbound_chain TEXT NOT NULL,
  inbound_seq    INTEGER NOT NULL DEFAULT 0,
  inbound_chain  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;
