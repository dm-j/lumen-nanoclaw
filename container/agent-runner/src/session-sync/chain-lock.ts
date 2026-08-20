/**
 * Cross-process exclusive lock over the shared outbound chain (the
 * `outbound_seq`/`outbound_chain` columns of .sync-local/outbound.db's
 * session_sync_state row). Every writer that advances that chain — the
 * persistent agent-runner client (client.ts) and short-lived CLI pushes
 * (cli/sync-outbound-push.ts, used by ncl.ts/host-shim.ts) — must hold this
 * lock while it has an unacked push in flight. Without it, two writers can
 * both read the same on-disk seq, both send, and the loser gets a
 * `resync_point` the host never lets it recover from (server.ts: divergence
 * recovery isn't built) — it fails permanently until the container restarts.
 * See docs/session-sync-transport.md for the incident this was found from.
 *
 * File lock via O_CREAT|O_EXCL. `tryAcquireChainLockSync` is synchronous and
 * non-blocking — the uncontended case (no sibling writer active), which is
 * the overwhelming majority of pushes — so callers that need to preserve a
 * synchronous send path (client.ts's same-tick multi-push batching) can stay
 * synchronous when nothing is fighting them for the lock.
 * `acquireChainLockAsync` is the contended fallback: polls with `setTimeout`,
 * never `Bun.sleepSync` — client.ts runs this inside the long-lived
 * agent-runner event loop, and a blocking sleep there would stall the poll
 * loop, mcp tools, and heartbeat for as long as a sibling CLI subprocess
 * holds the lock.
 */
import fs from 'fs';
import path from 'path';

const LOCK_STALE_MS = 15_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

function lockPath(syncLocalDir: string): string {
  return path.join(syncLocalDir, '.outbound-chain.lock');
}

/** Removes a lock file left behind by a crashed holder, once it's older than LOCK_STALE_MS. Returns whether it broke a stale lock (worth retrying immediately). */
function breakIfStale(p: string): boolean {
  try {
    if (Date.now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(p, { force: true });
      return true;
    }
  } catch {
    // Lock vanished between the failed create and this stat — treat as gone.
    return true;
  }
  return false;
}

/** Non-blocking single attempt. Returns true if acquired, false if another process currently holds a live (non-stale) lock. */
export function tryAcquireChainLockSync(syncLocalDir: string): boolean {
  const p = lockPath(syncLocalDir);
  try {
    fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!breakIfStale(p)) return false;
    try {
      fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits asynchronously (never blocks the event loop) until the lock is free and acquired, or throws after LOCK_TIMEOUT_MS. */
export async function acquireChainLockAsync(syncLocalDir: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (tryAcquireChainLockSync(syncLocalDir)) return;
    if (Date.now() > deadline) throw new Error('session-sync: timed out waiting for the outbound chain lock');
    await sleep(LOCK_RETRY_MS);
  }
}

export function releaseChainLock(syncLocalDir: string): void {
  try {
    fs.rmSync(lockPath(syncLocalDir), { force: true });
  } catch {
    // Already gone — fine.
  }
}
