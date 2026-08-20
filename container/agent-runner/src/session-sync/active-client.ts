/**
 * Wiring seam between "the container wrote a new outbound-direction row
 * locally" and the connected SyncClientHandle — mirrors the host's
 * src/session-sync/inbound-push.ts singleton pattern, so db/*.ts modules
 * (messages-out.ts, messages-in.ts, session-state.ts, connection.ts) can
 * push after a local write without importing the connection layer or
 * index.ts's startup sequence directly.
 *
 * `registerSyncClient` is called once from index.ts, right after
 * `initSessionSync()` resolves. Before that call (or under 'file'
 * transport, where `initSessionSync()` returns null), `getSyncClient()`
 * returns null and every push call site becomes a no-op via `?.`.
 */
import type { SyncClientHandle } from './client.js';

let activeClient: SyncClientHandle | null = null;

export function registerSyncClient(client: SyncClientHandle | null): void {
  activeClient = client;
}

/** Test-only: reset the module-level singleton between test files. */
export function clearSyncClient(): void {
  activeClient = null;
}

export function getSyncClient(): SyncClientHandle | null {
  return activeClient;
}
