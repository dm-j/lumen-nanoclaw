/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { getConfig } from '../config.js';
import { getSyncClient } from '../session-sync/active-client.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

function log(msg: string): void {
  console.error(`[db/connection] ${msg}`);
}

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

// Under 'sync' transport, the container owns a genuinely local copy of both
// DBs instead of opening the host-mounted /workspace/{inbound,outbound}.db
// files — those still exist on disk (host keeps writing its own canonical
// copies per docs/session-sync-transport.md §8.1) but nothing here ever
// opens them, so there's no concurrent SQLite writer on the same inode
// (the actual VirtioFS corruption mechanism this transport exists to avoid).
// Lives inside the same mounted sessDir tree so it survives a container
// respawn — no resync/backfill mechanism exists yet to repopulate it from
// scratch (see docs/session-sync-transport.md §8.2's still-open items).
const DEFAULT_SYNC_LOCAL_DIR = '/workspace/.sync-local';
let _syncLocalDir = DEFAULT_SYNC_LOCAL_DIR;
let _transportOverride: 'file' | 'sync' | null = null;

/** Test-only: point the local-sync directory somewhere writable outside a real container. */
export function setSyncLocalDirForTest(dir: string): void {
  _syncLocalDir = dir;
}

/** Test-only: force isSyncTransport() without going through config.ts's load-once container.json singleton. */
export function setTransportForTest(transport: 'file' | 'sync' | null): void {
  _transportOverride = transport;
}

function isSyncTransport(): boolean {
  if (_transportOverride) return _transportOverride === 'sync';
  try {
    return getConfig().transport === 'sync';
  } catch {
    // Config not loaded yet (e.g. test harness) — treat as 'file', the default.
    return false;
  }
}

function inboundPath(): string {
  return isSyncTransport() ? path.join(_syncLocalDir, 'inbound.db') : DEFAULT_INBOUND_PATH;
}

function outboundPath(): string {
  return isSyncTransport() ? path.join(_syncLocalDir, 'outbound.db') : DEFAULT_OUTBOUND_PATH;
}

/** bun:sqlite rejects `{ readonly: false }` outright ("flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE") — omit the option entirely for RW instead of passing a literal false. */
function inboundOpenOptions(): { readonly: true } | undefined {
  return isSyncTransport() ? undefined : { readonly: true };
}

/** Ensure the local-sync directory + schema exist before first open. Idempotent, no-op under 'file' transport. */
function ensureSyncLocalSchema(): void {
  if (!isSyncTransport()) return;
  fs.mkdirSync(_syncLocalDir, { recursive: true });
  const inPath = inboundPath();
  const outPath = outboundPath();
  if (!fs.existsSync(inPath)) {
    const db = new Database(inPath);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.close();
  }
  if (!fs.existsSync(outPath)) {
    const db = new Database(outPath);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(OUTBOUND_SCHEMA);
    db.close();
  }
}

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _testMode = false;

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return {
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => db.exec(sql),
      close: () => {},
    } as unknown as Database;
  }
  ensureSyncLocalSchema();
  const db = new Database(inboundPath(), inboundOpenOptions());
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    ensureSyncLocalSchema();
    _inbound = new Database(inboundPath(), inboundOpenOptions());
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (!_outbound) {
    ensureSyncLocalSchema();
    _outbound = new Database(outboundPath());
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA foreign_keys = ON');
    // Lightweight forward-compat: session_state was added after the initial
    // v2 schema, so older session DBs don't have it. Create it on demand
    // instead of requiring a formal migration pass. Also handle the case
    // where an earlier revision of this table existed without updated_at —
    // ALTER TABLE to add any missing columns.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (_outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('updated_at')) {
      _outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    // container_state: tracks the current tool in flight (if any) so the host
    // sweep can widen its stuck tolerance when Bash is running with a user-
    // declared long timeout. Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
    // session-sync chain checkpoints (container side, 'sync' transport only —
    // unused under the default 'file' transport). Two directions in one row:
    // outbound_* is this container's own send chain (verified by the host);
    // inbound_* is the last host-pushed row this container has applied. See
    // container/agent-runner/src/session-sync/client.ts.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_sync_state (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        outbound_seq   INTEGER NOT NULL DEFAULT 0,
        outbound_chain TEXT NOT NULL,
        inbound_seq    INTEGER NOT NULL DEFAULT 0,
        inbound_chain  TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `);
  }
  return _outbound;
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool, declaredTimeoutMs, now, now);
  pushContainerState({ current_tool: tool, tool_declared_timeout_ms: declaredTimeoutMs, tool_started_at: now, updated_at: now });
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
  pushContainerState({ current_tool: null, tool_declared_timeout_ms: null, tool_started_at: null, updated_at: now });
}

function pushContainerState(row: {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
  updated_at: string;
}): void {
  getSyncClient()
    ?.pushContainerState(row)
    .catch((err) => log(`pushContainerState failed: ${String(err)}`));
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(INBOUND_SCHEMA);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(OUTBOUND_SCHEMA);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
  _syncLocalDir = DEFAULT_SYNC_LOCAL_DIR;
  _transportOverride = null;
}
