/**
 * Tests for session-manager's direct outbound write path.
 *
 * Drives the real `writeOutboundDirect` entry against a real session folder
 * on disk. A previous implementation opened the outbound DB through
 * `openOutboundDb` (readonly: true), so every INSERT threw SQLITE_READONLY
 * and the command-gate denial path silently never delivered. Goes red if the
 * open call reverts to the readonly form.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import {
  backfillPendingInbound,
  initSessionFolder,
  inboundDbPath,
  outboundDbPath,
  releaseStagedMessage,
  sessionDir,
  writeOutboundDirect,
  writeSessionMessage,
} from './session-manager.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import * as inboundPush from './session-sync/inbound-push.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-write-outbound';
const AG = 'ag-test';
const SESS = 'sess-test';

function readMessagesOut(): Array<{ id: string; seq: number; kind: string; content: string }> {
  const db = new Database(outboundDbPath(AG, SESS), { readonly: true });
  try {
    return db.prepare('SELECT id, seq, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      seq: number;
      kind: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('writeOutboundDirect', () => {
  it('inserts into messages_out with an even host-side seq (requires a writable outbound.db)', () => {
    // With a readonly open this very call throws SQLITE_READONLY.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'Admin commands are restricted.' }),
    });

    const rows = readMessagesOut();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('denial-1');
    expect(rows[0].seq).toBe(2);
    expect(rows[0].seq % 2).toBe(0); // host uses even seq numbers
    expect(JSON.parse(rows[0].content).text).toBe('Admin commands are restricted.');
  });

  it('keeps host seq numbers even across multiple writes and ignores duplicate ids', () => {
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"first"}',
    });
    writeOutboundDirect(AG, SESS, {
      id: 'denial-2',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"second"}',
    });
    // INSERT OR IGNORE — a delivery retry with the same id must not throw or duplicate.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"retry"}',
    });

    const rows = readMessagesOut();
    expect(rows.map((r) => r.id)).toEqual(['denial-1', 'denial-2']);
    expect(rows.map((r) => r.seq)).toEqual([2, 4]);
  });
});

/**
 * Found via a live 'sync'-transport canary flip: an already-warm container
 * receiving a wake-triggering message goes through writeSessionMessage's
 * `stage: true` path (to avoid racing the host's own synth step), and only
 * becomes visible to the container's poll loop once releaseStagedMessage
 * flips status 'staged' → 'pending'. That flip must also push under 'sync'
 * transport — without it, the container's local copy of the row stays
 * stuck at 'staged' forever (getPendingMessages only reads 'pending'), and
 * the message is silently never processed for the lifetime of that container.
 */
describe('releaseStagedMessage pushes the status flip under sync transport', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: AG, name: AG, folder: AG, agent_provider: null, created_at: new Date().toISOString() });
    createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    } as Session);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it('calls notifyInboundWrite with the released row (status: pending)', () => {
    writeSessionMessage(AG, SESS, {
      id: 'stage-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
      stage: true,
    });

    const notify = vi.spyOn(inboundPush, 'notifyInboundWrite');
    releaseStagedMessage(AG, SESS, 'stage-1');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(AG, SESS, expect.objectContaining({ id: 'stage-1', status: 'pending' }));
  });

  it('does not push when the row was never staged (already pending, or missing)', () => {
    writeSessionMessage(AG, SESS, {
      id: 'not-staged',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
    });

    const notify = vi.spyOn(inboundPush, 'notifyInboundWrite');
    releaseStagedMessage(AG, SESS, 'not-staged');

    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * Found via a live 'sync'-transport canary flip: routeInbound() writes the
 * triggering messages_in row and *then* spawns the container, which takes a
 * real multi-second TLS round trip to connect — so the write always races
 * the connection, and notifyInboundWrite's push always no-ops (no `ws` yet).
 * Without a connect-time backfill, the very message that woke a cold
 * container is invisible to it, and the container hangs forever with no
 * error (it's just correctly waiting on a message that never arrives).
 */
describe('backfillPendingInbound pushes every pending row on connect', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: AG, name: AG, folder: AG, agent_provider: null, created_at: new Date().toISOString() });
    createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    } as Session);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it('pushes pending rows but skips delivered/processing ones', () => {
    writeSessionMessage(AG, SESS, {
      id: 'pending-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
    });
    writeSessionMessage(AG, SESS, {
      id: 'staged-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: '{}',
      stage: true,
    });

    const notify = vi.spyOn(inboundPush, 'notifyInboundWrite');
    backfillPendingInbound(AG, SESS);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(AG, SESS, expect.objectContaining({ id: 'pending-1', status: 'pending' }));
  });

  it('does nothing when the inbound.db does not exist yet', () => {
    const notify = vi.spyOn(inboundPush, 'notifyInboundWrite');
    expect(() => backfillPendingInbound(AG, 'sess-never-provisioned')).not.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * The `/debug` skill tells operators to `rm -rf` a session folder to reset a
 * stuck session. The sessions row survives, so the next message takes the
 * existing-session path and lands in `writeSessionMessage` with a missing
 * inbound.db. Without re-provisioning, better-sqlite3 throws on open and the
 * message is logged-and-dropped forever — the reset silently kills the chat.
 */
describe('writeSessionMessage re-provisions a deleted session folder', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: AG,
      name: 'Reset',
      folder: 'reset',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const sess: Session = {
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(sess);
  });

  afterEach(() => {
    closeDb();
  });

  it('re-creates the folder + inbound.db and does not throw when the row still exists', () => {
    // Operator resets a stuck session by deleting its folder; the row survives.
    fs.rmSync(sessionDir(AG, SESS), { recursive: true, force: true });
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(false);

    expect(() =>
      writeSessionMessage(AG, SESS, {
        id: 'after-reset-1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        content: JSON.stringify({ text: 'still here?' }),
      }),
    ).not.toThrow();

    // The folder + inbound.db are back and the message landed.
    expect(fs.existsSync(inboundDbPath(AG, SESS))).toBe(true);
    const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
    try {
      const row = db.prepare('SELECT id, content FROM messages_in WHERE id = ?').get('after-reset-1') as
        | { id: string; content: string }
        | undefined;
      expect(row?.id).toBe('after-reset-1');
      expect(JSON.parse(row!.content).text).toBe('still here?');
    } finally {
      db.close();
    }
  });
});
