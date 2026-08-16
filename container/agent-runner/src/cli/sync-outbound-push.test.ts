import { execFileSync } from 'child_process';
import fs from 'fs';
import { createServer as createHttpsServer } from 'https';
import os from 'os';
import path from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WebSocketServer, type WebSocket } from 'ws';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../db/schema.js';

const { pushCompletedAck, readTransport, setPathsForTest, writeAndPushSystemMessage } = await import(
  `./sync-outbound-push.js?t=${Date.now()}`
);

function makeCert(dir: string): { cert: string; key: string } {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=test',
  ]);
  return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

/** Fake host: acks every session-sync push it receives, echoing seq back. */
function startFakeHost(): { url: string; cert: string; close(): void; received: unknown[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-outbound-push-'));
  const { cert, key } = makeCert(dir);
  const httpsServer = createHttpsServer({ cert, key });
  const wss = new WebSocketServer({ server: httpsServer });
  const received: unknown[] = [];

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString()) as { channel: string; body: { seq: number } };
      received.push(envelope.body);
      ws.send(JSON.stringify({ channel: 'session-sync', body: { type: 'ack', seq: envelope.body.seq } }));
    });
  });

  const port = 0;
  httpsServer.listen(port);
  const addr = httpsServer.address() as { port: number };

  return {
    url: `wss://127.0.0.1:${addr.port}`,
    cert,
    close: () => httpsServer.close(),
    received,
  };
}

describe('sync-outbound-push', () => {
  let dir: string;
  let host: ReturnType<typeof startFakeHost>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-outbound-push-workspace-'));
    fs.mkdirSync(path.join(dir, 'agent'));
    fs.mkdirSync(path.join(dir, 'sync-local'));

    host = startFakeHost();

    fs.writeFileSync(path.join(dir, 'agent', 'container.json'), JSON.stringify({ transport: 'sync' }));
    fs.writeFileSync(
      path.join(dir, 'credentials.json'),
      JSON.stringify({ url: host.url, token: 'test-token', pinnedCertPem: host.cert }),
    );

    setPathsForTest({
      configPath: path.join(dir, 'agent', 'container.json'),
      credentialsPath: path.join(dir, 'credentials.json'),
      syncLocalDir: path.join(dir, 'sync-local'),
    });

    const outDb = new Database(path.join(dir, 'sync-local', 'outbound.db'));
    outDb.exec(OUTBOUND_SCHEMA);
    outDb.close();
    const inDb = new Database(path.join(dir, 'sync-local', 'inbound.db'));
    inDb.exec(INBOUND_SCHEMA);
    inDb.close();
  });

  afterEach(() => {
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readTransport reads sync from container.json', () => {
    expect(readTransport()).toBe('sync');
  });

  it('writeAndPushSystemMessage inserts the row locally and pushes it, acked by the host', async () => {
    await writeAndPushSystemMessage('req-1', { action: 'cli_request', requestId: 'req-1', command: 'groups-list', args: {} });

    const outDb = new Database(path.join(dir, 'sync-local', 'outbound.db'), { readonly: true });
    const row = outDb.prepare('SELECT id, kind FROM messages_out WHERE id = ?').get('req-1') as
      | { id: string; kind: string }
      | undefined;
    outDb.close();
    expect(row).toEqual({ id: 'req-1', kind: 'system' });

    expect(host.received).toHaveLength(1);
    expect((host.received[0] as { kind: string }).kind).toBe('outbound');
  });

  it('advances the local outbound chain seq across two calls, in order', async () => {
    await writeAndPushSystemMessage('req-1', { a: 1 });
    await pushCompletedAck('msg-1');

    const outDb = new Database(path.join(dir, 'sync-local', 'outbound.db'), { readonly: true });
    const state = outDb.prepare('SELECT outbound_seq FROM session_sync_state WHERE id = 1').get() as {
      outbound_seq: number;
    };
    outDb.close();
    expect(state.outbound_seq).toBe(2);

    expect(host.received.map((m) => (m as { seq: number }).seq)).toEqual([1, 2]);
  });

  it('pushCompletedAck marks processing_ack locally and pushes an ack row', async () => {
    await pushCompletedAck('msg-42');

    const outDb = new Database(path.join(dir, 'sync-local', 'outbound.db'), { readonly: true });
    const row = outDb.prepare('SELECT message_id, status FROM processing_ack WHERE message_id = ?').get('msg-42') as
      | { message_id: string; status: string }
      | undefined;
    outDb.close();
    expect(row).toEqual({ message_id: 'msg-42', status: 'completed' });

    expect(host.received).toHaveLength(1);
    expect(host.received[0]).toMatchObject({ kind: 'ack', payload: { message_id: 'msg-42', status: 'completed' } });
  });

  it('rejects when the host never acks (timeout)', async () => {
    host.close(); // no listener at all now
    await expect(writeAndPushSystemMessage('req-timeout', {})).rejects.toThrow();
  });
});
