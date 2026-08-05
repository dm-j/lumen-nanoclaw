/**
 * Integration coverage for the lazy re-caption + persist path in
 * literal-tail.ts's resolveInboundText — a message stored before image
 * captioning existed (staged attachment, no `caption`/`captionError` yet)
 * gets captioned on first render and the result is written back to
 * messages_in, so a second render doesn't re-caption.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: () => ({
      jpeg: () => ({
        toBuffer: async () => Buffer.from('fake-jpeg-bytes'),
      }),
    }),
  })),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-literal-tail-persist' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { openInboundDb } from '../../db/session-db.js';
import { renderLiteralTail } from './literal-tail.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-literal-tail-persist';
const AG = 'ag-tailpersist';
const SESS = 'sess-tailpersist';

function now(): string {
  return new Date().toISOString();
}

function mockFetchOnce(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ response: text }),
    }),
  );
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'TailPersist', folder: 'tailpersist', agent_provider: null, created_at: now() });
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
  vi.unstubAllGlobals();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('literal-tail lazy re-caption + persist', () => {
  it('captions a pre-existing staged image on first render and persists it', async () => {
    // Simulates a message stored before captioning existed: an image
    // attachment already staged to disk (extractAttachmentFiles's normal
    // job) with no caption/captionError field.
    writeSessionMessage(AG, SESS, {
      id: 'msg-old-image',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:123',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        sender: 'David',
        attachments: [{ type: 'image', name: 'photo.jpg', data: Buffer.from('original-bytes').toString('base64') }],
      }),
    });

    mockFetchOnce('A red bicycle leaning against a brick wall.');

    const tail = await renderLiteralTail(AG, SESS, 'sesskey-1', 'responder', 5);
    expect(tail).toContain('A red bicycle leaning against a brick wall.');

    // Persisted: re-reading the row directly shows the caption landed in content.
    const db = openInboundDb(path.join(sessionDir(AG, SESS), 'inbound.db'));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-old-image') as { content: string };
    db.close();
    const parsed = JSON.parse(row.content);
    expect(parsed.attachments[0].caption).toBe('A red bicycle leaning against a brick wall.');

    // Second render must not re-caption — only one fetch call total.
    await renderLiteralTail(AG, SESS, 'sesskey-1', 'responder', 5);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('persists a captionError when Ollama is unreachable', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-old-image-2',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:123',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        sender: 'David',
        attachments: [{ type: 'image', name: 'photo2.jpg', data: Buffer.from('original-bytes-2').toString('base64') }],
      }),
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434')));

    const tail = await renderLiteralTail(AG, SESS, 'sesskey-2', 'responder', 5);
    expect(tail).toContain('no description available yet');
  });

  it('retries on the next render after a transient failure, and stops retrying once it succeeds', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-old-image-3',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:123',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        sender: 'David',
        attachments: [{ type: 'image', name: 'photo3.jpg', data: Buffer.from('original-bytes-3').toString('base64') }],
      }),
    });

    // First render: transient failure — captionError only, no caption yet.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    const first = await renderLiteralTail(AG, SESS, 'sesskey-3', 'responder', 5);
    expect(first).toContain('no description available yet');

    // Second render: Ollama recovered — the lazy path must retry (captionError
    // alone never blocks a retry, only a landed caption does) and the stale
    // captionError must be cleared once it succeeds.
    mockFetchOnce('A bicycle.');
    const second = await renderLiteralTail(AG, SESS, 'sesskey-3', 'responder', 5);
    expect(second).toContain('A bicycle.');
    expect(second).not.toContain('no description available yet');

    // Third render: caption already landed — must not call fetch again.
    const fetchCallsSoFar = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await renderLiteralTail(AG, SESS, 'sesskey-3', 'responder', 5);
    expect(fetch).toHaveBeenCalledTimes(fetchCallsSoFar);
  });

  it('stops retrying a persistently-failing caption after the attempt cap, instead of hammering it on every render', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-old-image-4',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:123',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        sender: 'David',
        attachments: [{ type: 'image', name: 'photo4.jpg', data: Buffer.from('original-bytes-4').toString('base64') }],
      }),
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Ollama returned 500 Internal Server Error')));

    // Renders 1-3 each attempt (and fail) — that's the cap.
    for (let i = 0; i < 3; i++) {
      await renderLiteralTail(AG, SESS, 'sesskey-4', 'responder', 5);
    }
    expect(fetch).toHaveBeenCalledTimes(3);

    // Render 4+ must not call fetch again — the cap was hit.
    await renderLiteralTail(AG, SESS, 'sesskey-4', 'responder', 5);
    await renderLiteralTail(AG, SESS, 'sesskey-4', 'responder', 5);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
