import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-readpendingbatch' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import { readPendingBatchText } from './db.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-readpendingbatch';
const AG = 'ag-readpendingbatch';
const SESS = 'sess-readpendingbatch';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: AG,
    name: 'ReadPendingBatch',
    folder: 'readpendingbatch',
    agent_provider: null,
    created_at: now(),
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
    created_at: now(),
  };
  createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('readPendingBatchText', () => {
  it('prefixes a normal message with its local timestamp and sender', () => {
    writeSessionMessage(AG, SESS, {
      id: 'm1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ sender: 'David', text: 'hello' }),
    });
    const result = readPendingBatchText(AG, SESS);
    expect(result).toMatch(/^> \[.+\] David:\n> hello$/);
  });

  it('defaults to "user" when the message carries no sender field', () => {
    writeSessionMessage(AG, SESS, {
      id: 'm0',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ text: 'hello' }),
    });
    expect(readPendingBatchText(AG, SESS)).toMatch(/^> \[.+\] user:\n> hello$/);
  });

  it('renders a bracketed placeholder instead of dumping raw JSON for a captionless image', () => {
    writeSessionMessage(AG, SESS, {
      id: 'm2',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        sender: 'David',
        attachments: [{ type: 'image', name: 'photo.jpg', data: Buffer.from('bytes').toString('base64') }],
      }),
    });
    expect(readPendingBatchText(AG, SESS)).toMatch(/^> \[.+\] David:\n> \[image: photo\.jpg\]$/);
  });

  it('labels a scheduled task with a "Scheduled task" sender', () => {
    writeSessionMessage(AG, SESS, {
      id: 'm3',
      kind: 'task',
      timestamp: now(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'Check the mail' }),
    });
    expect(readPendingBatchText(AG, SESS)).toMatch(/^> \[.+\] Scheduled task:\n> Check the mail$/);
  });
});
