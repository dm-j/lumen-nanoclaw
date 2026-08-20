import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execHostShimMock } = vi.hoisted(() => ({ execHostShimMock: vi.fn() }));
vi.mock('../host-shim/exec.js', () => ({
  execHostShim: execHostShimMock,
}));

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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-vault-transcript' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import { appendPendingInboundTurns, appendDeliveredOutboundTurn } from './index.js';
import { setEnabled } from './db.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-test-vault-transcript';
const AG = 'ag-vaulttranscript';
// lastExportedSeq is a module-level in-memory watermark keyed by sessionId,
// not reset between tests — reusing one session id across tests would leak
// the watermark from an earlier test's fresh (seq-reset) DB into the next.
let SESS = '';
let testCounter = 0;

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  testCounter += 1;
  SESS = `sess-vaulttranscript-${testCounter}`;

  execHostShimMock.mockReset();
  execHostShimMock.mockResolvedValue({ ok: true, exitCode: 0, stdout: '', stderr: '' });

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: AG,
    name: 'VaultTranscript',
    folder: 'vaulttranscript',
    agent_provider: null,
    created_at: now(),
  });
  setEnabled(AG, true);
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

describe('appendDeliveredOutboundTurn', () => {
  it('passes plain text through with no image arg', async () => {
    await appendDeliveredOutboundTurn(AG, 'Assistant', now(), JSON.stringify({ text: 'hello there' }));
    expect(execHostShimMock).toHaveBeenCalledWith(AG, 'transcript-append', [
      'Assistant',
      expect.any(String),
      'hello there',
    ]);
  });
});

describe('appendPendingInboundTurns', () => {
  it('renders a placeholder instead of raw JSON for a captionless-shape attachment', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ sender: 'David', attachments: [{ type: 'file', name: 'doc.pdf' }] }),
    });

    await appendPendingInboundTurns(AG, SESS);

    expect(execHostShimMock).toHaveBeenCalledTimes(1);
    const args = execHostShimMock.mock.calls[0][2] as string[];
    expect(args[2]).toBe('[file: doc.pdf]');
    expect(args).toHaveLength(3); // no image arg for a non-image attachment
  });

  it('attaches a resized temp image when the attachment is caption-gated, and deletes it after', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-2',
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

    // Manually stamp a caption + localPath onto the stored row, simulating
    // what router.ts's ingest-time captionAttachments would have done —
    // writeSessionMessage above already staged the file via
    // extractAttachmentFiles, so localPath is real; we just add the caption.
    const { openInboundDb } = await import('../../db/session-db.js');
    const { inboundDbPath } = await import('../../session-manager.js');
    const db = openInboundDb(inboundDbPath(AG, SESS));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-2') as { content: string };
    const parsed = JSON.parse(row.content);
    parsed.attachments[0].caption = 'A red bicycle.';
    db.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(parsed), 'msg-2');
    db.close();

    let capturedPath = '';
    execHostShimMock.mockImplementation(async (_ag: string, _name: string, args: string[]) => {
      capturedPath = args[3];
      expect(fs.existsSync(capturedPath)).toBe(true); // exists at call time
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    });

    await appendPendingInboundTurns(AG, SESS);

    expect(execHostShimMock).toHaveBeenCalledTimes(1);
    const args = execHostShimMock.mock.calls[0][2] as string[];
    expect(args).toHaveLength(4);
    expect(args[2]).toBe('[image: photo.jpg] A red bicycle.');
    expect(fs.existsSync(capturedPath)).toBe(false); // cleaned up after the call
  });

  it('does not attach an image when captioning failed', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-3',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        sender: 'David',
        attachments: [{ type: 'image', name: 'photo2.jpg', data: Buffer.from('bytes').toString('base64') }],
      }),
    });

    const { openInboundDb } = await import('../../db/session-db.js');
    const { inboundDbPath } = await import('../../session-manager.js');
    const db = openInboundDb(inboundDbPath(AG, SESS));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-3') as { content: string };
    const parsed = JSON.parse(row.content);
    parsed.attachments[0].captionError = 'connect ECONNREFUSED';
    db.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(parsed), 'msg-3');
    db.close();

    await appendPendingInboundTurns(AG, SESS);

    const args = execHostShimMock.mock.calls[0][2] as string[];
    expect(args).toHaveLength(3);
    expect(args[2]).toBe('[image: photo2.jpg] (no description available yet — try again shortly)');
  });

  it('skips a captioning-job completion notice (id prefix "caption-") — it gets its own vault line via appendCaptionedAttachment, not this generic export', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'caption-image-ab12-1234567890',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        sender: 'System',
        text: 'Image "photo.jpg" (id: image-ab12) has been described:\n\nA red bicycle.',
      }),
    });

    await appendPendingInboundTurns(AG, SESS);

    expect(execHostShimMock).not.toHaveBeenCalled();
  });

  it('skips export entirely for a group without vault_transcript_enabled', async () => {
    setEnabled(AG, false);
    writeSessionMessage(AG, SESS, {
      id: 'msg-disabled-1',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ sender: 'User', text: 'hello' }),
    });

    await appendPendingInboundTurns(AG, SESS);

    expect(execHostShimMock).not.toHaveBeenCalled();
  });
});
