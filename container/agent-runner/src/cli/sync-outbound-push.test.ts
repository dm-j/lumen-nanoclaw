import { execFileSync } from 'child_process';
import fs from 'fs';
import { createServer as createHttpsServer } from 'https';
import os from 'os';
import path from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WebSocketServer, type WebSocket } from 'ws';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../db/schema.js';

const { pushCompletedAck, readTransport, setAckTimeoutForTest, setPathsForTest, writeAndPushSystemMessage } = await import(
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

/**
 * Fake host whose behavior on each successive connection is scripted via
 * `behaviors[connectionIndex]` (defaults to 'normal' past the end of the
 * array) — for testing pushOverSyncConnection's retry loop, which opens a
 * fresh connection per attempt. Always answers resync_request accurately
 * against its own applied-rows state, matching the real host's protocol
 * (src/session-sync/server.ts's makeSessionSyncHandler).
 */
function startScriptableHost(): {
  url: string;
  cert: string;
  close(): void;
  received: unknown[];
  behaviors: Array<'normal' | 'apply-no-ack' | 'silent-close'>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-outbound-push-'));
  const { cert, key } = makeCert(dir);
  const httpsServer = createHttpsServer({ cert, key });
  const wss = new WebSocketServer({ server: httpsServer });
  const received: unknown[] = [];
  const behaviors: Array<'normal' | 'apply-no-ack' | 'silent-close'> = [];
  let connectionCount = 0;
  let appliedSeq = 0;

  wss.on('connection', (ws: WebSocket) => {
    const behavior = behaviors[connectionCount] ?? 'normal';
    connectionCount++;
    ws.on('message', (raw) => {
      const envelope = JSON.parse(raw.toString()) as { channel: string; body: { type?: string; seq: number } };
      if (envelope.body.type === 'resync_request') {
        ws.send(JSON.stringify({ channel: 'session-sync', body: { type: 'resync_point', seq: appliedSeq, chain: '' } }));
        return;
      }
      if (behavior === 'silent-close') {
        ws.close();
        return;
      }
      received.push(envelope.body);
      appliedSeq = envelope.body.seq;
      if (behavior === 'apply-no-ack') return; // applied, but the ack itself is the thing that gets lost
      ws.send(JSON.stringify({ channel: 'session-sync', body: { type: 'ack', seq: envelope.body.seq } }));
    });
  });

  const port = 0;
  httpsServer.listen(port);
  const addr = httpsServer.address() as { port: number };

  return { url: `wss://127.0.0.1:${addr.port}`, cert, close: () => httpsServer.close(), received, behaviors };
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
    setAckTimeoutForTest(10_000);
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

  describe('retry across a reconnect (docs/session-sync-transport.md §8.11 track 2)', () => {
    it('resends over a fresh connection when the row never reached the host at all', async () => {
      const flaky = startScriptableHost();
      flaky.behaviors[0] = 'silent-close'; // first attempt: connection dies before the row is even received
      setPathsForTest({
        configPath: path.join(dir, 'agent', 'container.json'),
        credentialsPath: path.join(dir, 'credentials.json'),
        syncLocalDir: path.join(dir, 'sync-local'),
      });
      fs.writeFileSync(
        path.join(dir, 'credentials.json'),
        JSON.stringify({ url: flaky.url, token: 'test-token', pinnedCertPem: flaky.cert }),
      );
      setAckTimeoutForTest(200);

      await writeAndPushSystemMessage('req-1', { a: 1 });

      expect(flaky.received).toHaveLength(1);
      expect((flaky.received[0] as { seq: number }).seq).toBe(1);
      flaky.close();
    });

    it('treats a resync_point reporting the host already applied the row as success, without resending it', async () => {
      const flaky = startScriptableHost();
      flaky.behaviors[0] = 'apply-no-ack'; // first attempt: host gets the row and applies it, but the ack itself never arrives back
      setPathsForTest({
        configPath: path.join(dir, 'agent', 'container.json'),
        credentialsPath: path.join(dir, 'credentials.json'),
        syncLocalDir: path.join(dir, 'sync-local'),
      });
      fs.writeFileSync(
        path.join(dir, 'credentials.json'),
        JSON.stringify({ url: flaky.url, token: 'test-token', pinnedCertPem: flaky.cert }),
      );
      setAckTimeoutForTest(200);

      await writeAndPushSystemMessage('req-1', { a: 1 });

      // Received exactly once — the retry's resync_request found the host
      // already at seq 1 and correctly did not resend the row a second time.
      expect(flaky.received).toHaveLength(1);

      const outDb = new Database(path.join(dir, 'sync-local', 'outbound.db'), { readonly: true });
      const state = outDb.prepare('SELECT outbound_seq FROM session_sync_state WHERE id = 1').get() as { outbound_seq: number };
      outDb.close();
      expect(state.outbound_seq).toBe(1);
      flaky.close();
    });
  });
});
