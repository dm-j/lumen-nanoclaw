/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { assignTask, sendFile, sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_file MCP tool — multiple files in one message', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-'));
    process.env.NANOCLAW_OUTBOX_DIR = path.join(dir, 'outbox');
  });
  afterEach(() => {
    delete process.env.NANOCLAW_OUTBOX_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mk(rel: string): string {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel);
    return p;
  }

  it('delivers several files as one outbound message, disambiguating a shared basename', async () => {
    const a = mk('m1/attachment-1.jpg');
    const b = mk('m2/attachment-1.jpg');

    await sendFile.handler({ to: 'peer', paths: [a, b], text: 'compare these' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.text).toBe('compare these');
    expect(content.files).toEqual(['attachment-1.jpg', '2-attachment-1.jpg']);
    const outbox = path.join(dir, 'outbox', out[0].id);
    expect(fs.readFileSync(path.join(outbox, 'attachment-1.jpg'), 'utf8')).toBe('m1/attachment-1.jpg');
    expect(fs.readFileSync(path.join(outbox, '2-attachment-1.jpg'), 'utf8')).toBe('m2/attachment-1.jpg');
  });

  it('sends nothing when any path is missing', async () => {
    const a = mk('a.jpg');

    const res = await sendFile.handler({ to: 'peer', paths: [a, path.join(dir, 'nope.jpg')] });

    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still accepts a single path with a display filename', async () => {
    await sendFile.handler({ to: 'peer', path: mk('a.jpg'), filename: 'renamed.jpg' });

    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.files).toEqual(['renamed.jpg']);
  });

  it('assign_task carries files in the same message as the work order', async () => {
    const a = mk('x/one.jpg');
    const b = mk('y/two.jpg');

    await assignTask.handler({ to: 'peer', task: 'compare', paths: [a, b] });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.text).toBe('compare');
    expect(typeof content.assignTaskId).toBe('string');
    expect(content.files).toEqual(['one.jpg', 'two.jpg']);
  });
});
