#!/usr/bin/env bun
/**
 * host-shim — invoke a whitelisted host-side executable from inside the
 * agent container.
 *
 * Usage: host-shim <name> [args...]
 *
 * Same DB-transport pattern as ./ncl.ts: writes a `host_shim_exec` system
 * message to outbound.db, polls inbound.db for the matching
 * `host_shim_response`, prints stdout/stderr, exits with the shim's exit
 * code. The host decides whether `<name>` is whitelisted for *this*
 * container's agent group (a `<name>-host` script exists in that group's
 * own whitelist directory) — this binary has no opinion, it's just the
 * transport, and it never learns which agent group it's running in; the
 * host resolves that from the session the request lands on.
 * Self-contained — no imports from agent-runner.
 */
import { Database } from 'bun:sqlite';

type ShimResponse = {
  requestId: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  refusalReason?: string;
};

const INBOUND_DB = '/workspace/inbound.db';
const OUTBOUND_DB = '/workspace/outbound.db';
// See mcp-tools/memory-fact.ts's HOST_SHIM_TIMEOUT_MS for why this needs to
// stay above the host's own execHostShim ceiling for subagent-dispatch shims
// (recall/remember/digest/briefing) rather than the old flat 30s.
const TIMEOUT_MS = 210_000;

function generateId(): string {
  return `shim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Mirrors ncl.ts's writeRequest — BEGIN IMMEDIATE to avoid seq collisions
// with concurrent agent-runner writes.
//
// timeoutMs: an mcp-shim's per-script override (see mcp-manifest.ts's
// `timeoutMs` field), threaded through by dynamic-shims.ts via the
// HOST_SHIM_TIMEOUT_MS_OVERRIDE env var — this CLI's own argv contract
// (name + payload) has no room for a third concept, so it rides along in
// the environment instead. Absent for plain host-shims calls.
function writeRequest(requestId: string, name: string, args: string[]): void {
  const timeoutOverride = process.env.HOST_SHIM_TIMEOUT_MS_OVERRIDE
    ? Number(process.env.HOST_SHIM_TIMEOUT_MS_OVERRIDE)
    : undefined;
  const db = new Database(OUTBOUND_DB);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA busy_timeout = 5000');

  const inDb = new Database(INBOUND_DB, { readonly: true });
  inDb.exec('PRAGMA busy_timeout = 5000');

  try {
    db.exec('BEGIN IMMEDIATE');
    const maxOut = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
    const maxIn = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const max = Math.max(maxOut, maxIn);
    const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, content)
       VALUES ($id, $seq, $timestamp, 'system', $content)`,
    ).run({
      $id: requestId,
      $seq: nextSeq,
      $timestamp: new Date().toISOString(),
      $content: JSON.stringify({
        action: 'host_shim_exec',
        requestId,
        name,
        args,
        ...(timeoutOverride && Number.isFinite(timeoutOverride) ? { timeoutMs: timeoutOverride } : {}),
      }),
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    inDb.close();
    db.close();
  }
}

// A read landing mid-write on a VirtioFS/bind-mount cross-mount boundary can
// surface as SQLITE_CORRUPT even though nothing on disk is actually damaged
// (see docker/for-mac#6690, #7494 — known Docker Desktop VirtioFS cache-
// coherency gap). Retried immediate/+1s/+2s, a fresh connection each time in
// case the stale state was connection-local; if all three attempts still
// throw, the row is treated as "not there yet" for this iteration and the
// outer poll loop's own 500ms cadence tries again — worth logging, not worth
// failing the whole shim call over.
const CORRUPT_RETRY_DELAYS_MS = [0, 1000, 2000];

function queryPendingRow(requestId: string): { id: string; content: string } | null {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CORRUPT_RETRY_DELAYS_MS.length; attempt++) {
    if (CORRUPT_RETRY_DELAYS_MS[attempt] > 0) Bun.sleepSync(CORRUPT_RETRY_DELAYS_MS[attempt]);

    const inDb = new Database(INBOUND_DB, { readonly: true });
    inDb.exec('PRAGMA busy_timeout = 5000');
    inDb.exec('PRAGMA mmap_size = 0');
    try {
      return inDb
        .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | null;
    } catch (err) {
      lastErr = err;
    } finally {
      inDb.close();
    }
  }
  process.stderr.write(
    `host-shim: inbound.db read failed after ${CORRUPT_RETRY_DELAYS_MS.length} attempts (likely transient cross-mount corruption), skipping this poll: ${lastErr}\n`,
  );
  return null;
}

// Mirrors ncl.ts's pollResponse — fresh connection each poll for cross-mount
// visibility, marks the row completed via processing_ack so the agent-runner
// poll loop never surfaces it as a normal message.
function pollResponse(requestId: string, timeoutMs: number): ShimResponse | null {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = queryPendingRow(requestId);

    if (row) {
      const outDb = new Database(OUTBOUND_DB);
      outDb.exec('PRAGMA journal_mode = DELETE');
      outDb.exec('PRAGMA busy_timeout = 5000');
      outDb
        .prepare(
          "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', ?)",
        )
        .run(row.id, new Date().toISOString());
      outDb.close();

      const parsed = JSON.parse(row.content);
      return parsed.response as ShimResponse;
    }

    Bun.sleepSync(500);
  }

  return null;
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  process.stderr.write('Usage: host-shim <name> [args...]\n');
  process.exit(2);
}

const [name, ...args] = argv;
const requestId = generateId();

writeRequest(requestId, name, args);
const resp = pollResponse(requestId, TIMEOUT_MS);

if (!resp) {
  process.stderr.write(`host-shim: "${name}" timed out after ${TIMEOUT_MS / 1000}s\n`);
  process.exit(2);
}

if (!resp.ok) {
  process.stderr.write(`host-shim: ${resp.refusalReason ?? 'refused'}\n`);
  process.exit(127);
}

if (resp.stdout) process.stdout.write(resp.stdout);
if (resp.stderr) process.stderr.write(resp.stderr);
process.exit(resp.exitCode);
