/** A pending follow-up is cancelled by cancelFollowups; other rows are untouched. */
import fs from 'fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-followup' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import { cancelFollowups } from './cancel.js';

const AG = 'ag-fu';
const SESS = 'sess-fu';
const now = () => new Date().toISOString();

beforeEach(() => {
  fs.rmSync('/tmp/nanoclaw-test-followup', { recursive: true, force: true });
  fs.mkdirSync('/tmp/nanoclaw-test-followup', { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: AG, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder(AG, SESS);
});
afterEach(() => {
  closeDb();
  fs.rmSync('/tmp/nanoclaw-test-followup', { recursive: true, force: true });
});

it('cancels pending follow-ups only', () => {
  for (const id of ['followup-1', 'msg-keep']) {
    writeSessionMessage(AG, SESS, { id, kind: 'chat', timestamp: now(), content: '{}', processAfter: now() });
  }
  expect(cancelFollowups(AG, SESS)).toBe(1);
  expect(cancelFollowups(AG, SESS)).toBe(0);
  const db = openInboundDb(AG, SESS);
  const status = (id: string) =>
    (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;
  expect([status('followup-1'), status('msg-keep')]).toEqual(['cancelled', 'pending']);
  db.close();
});
