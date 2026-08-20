/**
 * Coverage for the async captioning job: it reads the staged attachment
 * bytes back off disk, calls the (mocked) model, persists the result onto
 * the original message row, and writes a `system` message carrying the
 * captionId so the placeholder the agent already saw can be matched up.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const captionImageMock = vi.fn();
vi.mock('./caption.js', async () => {
  const actual = await vi.importActual<typeof import('./caption.js')>('./caption.js');
  return { ...actual, captionImage: (...args: Parameters<typeof actual.captionImage>) => captionImageMock(...args) };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-caption-notify' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { openInboundDb as openInboundDbAtPath } from '../../db/session-db.js';
import { triggerCaptioning } from './notify.js';

const TEST_DIR = '/tmp/nanoclaw-test-caption-notify';
const AG = 'ag-notify';
const SESS = 'sess-notify';

function now() {
  return new Date().toISOString();
}

function messagesInRows(): Array<{ id: string; content: string; kind: string }> {
  const db = openInboundDbAtPath(sessionDir(AG, SESS) + '/inbound.db');
  try {
    return db.prepare('SELECT id, content, kind FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      content: string;
      kind: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  // captionImageMock is a module-scope vi.fn(), not a vi.spyOn — afterEach's
  // vi.restoreAllMocks() doesn't reset a plain fn's queued/default
  // implementations, so a prior test's mockResolvedValue(...) would
  // otherwise leak into this one as a fallback once mockResolvedValueOnce
  // queues run dry.
  captionImageMock.mockReset();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
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
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeStagedImageMessage(id: string, captionId: string): void {
  // Mirrors what extractAttachmentFiles (session-manager.ts) leaves behind:
  // base64 `data` stripped, bytes staged to disk, `localPath` set. Skipping
  // the real base64 round-trip here — writeSessionMessage's own attachment
  // extraction is covered elsewhere; this test starts from its output shape.
  const filePath = `${sessionDir(AG, SESS)}/inbox/${id}/photo.jpg`;
  fs.mkdirSync(`${sessionDir(AG, SESS)}/inbox/${id}`, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from('fake-jpeg-bytes'));

  writeSessionMessage(AG, SESS, {
    id,
    kind: 'chat',
    timestamp: now(),
    content: JSON.stringify({
      attachments: [{ type: 'image', name: 'photo.jpg', localPath: `inbox/${id}/photo.jpg`, captionId }],
    }),
  });
}

describe('triggerCaptioning', () => {
  it('persists the caption on the original row and writes a system notice', async () => {
    captionImageMock.mockResolvedValue({ ok: true, text: 'A red bicycle.' });
    writeStagedImageMessage('msg-1', 'photo-ab12');

    await new Promise<void>((resolve) => {
      triggerCaptioning(AG, SESS, 'msg-1');
      setTimeout(resolve, 50);
    });

    const rows = messagesInRows();
    const original = rows.find((r) => r.id === 'msg-1')!;
    expect(JSON.parse(original.content).attachments[0].caption).toBe('A red bicycle.');

    // The completion notice must be kind: 'chat' — poll-loop.ts unconditionally
    // filters kind: 'system' rows out of every prompt-building path (they're
    // reserved for MCP tool responses), so a 'system' notice here would be
    // written and wake the container but never actually reach the agent.
    const notice = rows.find((r) => r.id.startsWith('caption-'))!;
    expect(notice).toBeTruthy();
    expect(notice.kind).toBe('chat');
    const parsed = JSON.parse(notice.content);
    expect(parsed.text).toContain('photo-ab12');
    expect(parsed.text).toContain('A red bicycle.');
  });

  it('persists captionError and reports status "error" on failure, after exhausting the (real-failure) retry budget', async () => {
    // A real failure (not "aborted") retries with a real backoff sleep
    // between attempts — fake timers so the test doesn't actually wait ~5s.
    vi.useFakeTimers();
    try {
      captionImageMock.mockResolvedValue({ ok: false, text: 'Ollama returned 500' });
      writeStagedImageMessage('msg-2', 'photo-cd34');

      triggerCaptioning(AG, SESS, 'msg-2');
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    const rows = messagesInRows();
    const original = rows.find((r) => r.id === 'msg-2')!;
    expect(JSON.parse(original.content).attachments[0].captionError).toBe('Ollama returned 500');

    const notice = rows.find((r) => r.id.startsWith('caption-'))!;
    expect(notice.kind).toBe('chat');
    const parsed = JSON.parse(notice.content);
    expect(parsed.text).toContain('could not be described');
    expect(parsed.text).toContain('Ollama returned 500');
  });

  it('retries contention (timeout) more times than a real failure, and only notifies once the retry loop settles', async () => {
    vi.useFakeTimers();
    try {
      // Fails 4 times with contention, then succeeds — within the contention
      // budget (5) but well past what a real failure would tolerate (2).
      captionImageMock
        .mockResolvedValueOnce({ ok: false, text: 'This operation was aborted' })
        .mockResolvedValueOnce({ ok: false, text: 'This operation was aborted' })
        .mockResolvedValueOnce({ ok: false, text: 'This operation was aborted' })
        .mockResolvedValueOnce({ ok: false, text: 'This operation was aborted' })
        .mockResolvedValueOnce({ ok: true, text: 'A dragon.' });
      writeStagedImageMessage('msg-4', 'photo-ef56');

      triggerCaptioning(AG, SESS, 'msg-4');
      await vi.advanceTimersByTimeAsync(120_000);
    } finally {
      vi.useRealTimers();
    }

    expect(captionImageMock).toHaveBeenCalledTimes(5);

    const rows = messagesInRows();
    const original = rows.find((r) => r.id === 'msg-4')!;
    expect(JSON.parse(original.content).attachments[0].caption).toBe('A dragon.');

    // Exactly one notice — none of the four interim contention failures
    // should have written anything to the agent's session.
    const notices = rows.filter((r) => r.id.startsWith('caption-'));
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0].content).text).toContain('A dragon.');
  });

  it('is a no-op when there are no un-captioned image attachments', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-3',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi' }),
    });

    await new Promise<void>((resolve) => {
      triggerCaptioning(AG, SESS, 'msg-3');
      setTimeout(resolve, 20);
    });

    const rows = messagesInRows();
    expect(rows.some((r) => r.id.startsWith('caption-'))).toBe(false);
  });
});
