/**
 * Ordered, backed-off retry for channels where a transient network failure
 * must not lose a message (Telegram — a ~35s link drop used to exhaust the old
 * 3 attempts in ~22s and drop the reply for good).
 *
 * - A message that fails transiently retries forever with a delay that grows
 *   5s per failure up to 60s, then stays at 60s.
 * - While any earlier message on the channel is in retry, later ones are held
 *   (not attempted, no delay assigned) so the channel stays chronological.
 *   When the blocker clears, held messages are tried immediately; one that
 *   then fails starts its own backoff from 5s.
 *
 * State is in-memory (a restart gives everything a fresh attempt, same as the
 * old attempt counter). ponytail: one global gate for the whole channel type,
 * per-chat gates if one chat's failures should not hold the others.
 */

const ORDERED_CHANNELS = new Set(['telegram']);
const STEP_MS = 5_000;
const MAX_DELAY_MS = 60_000;

interface Entry {
  sessionId: string;
  timestamp: string; // outbound row timestamp — the chronological key
  failures: number;
  nextAttemptAt: number;
}

const entries = new Map<string, Entry>();

export function isOrderedChannel(channelType: string | null | undefined): boolean {
  return !!channelType && ORDERED_CHANNELS.has(channelType);
}

/** Network-class errors worth retrying; anything else keeps the capped-attempts path. */
export function isTransientDeliveryError(err: unknown): boolean {
  const e = err as { name?: string; constructor?: { name?: string } } | null;
  const name = e?.constructor?.name ?? e?.name;
  return name === 'NetworkError' || name === 'AdapterRateLimitError' || e?.name === 'NetworkError';
}

export function retryDelayMs(failures: number): number {
  return Math.min(failures * STEP_MS, MAX_DELAY_MS);
}

/** True if this message must not be attempted now: its own backoff is pending, or an earlier message is in retry. */
export function isHeld(id: string, timestamp: string, now = Date.now()): boolean {
  const own = entries.get(id);
  if (own && now < own.nextAttemptAt) return true;
  for (const [otherId, e] of entries) {
    if (otherId !== id && e.timestamp < timestamp) return true;
  }
  return false;
}

export function recordFailure(
  id: string,
  sessionId: string,
  timestamp: string,
  now = Date.now(),
): { failures: number; delayMs: number } {
  const failures = (entries.get(id)?.failures ?? 0) + 1;
  const delayMs = retryDelayMs(failures);
  entries.set(id, { sessionId, timestamp, failures, nextAttemptAt: now + delayMs });
  return { failures, delayMs };
}

export function recordDone(id: string): void {
  entries.delete(id);
}

/** Drop entries for a session whose messages are no longer pending, so a vanished message can't hold the channel forever. */
export function pruneSession(sessionId: string, pendingIds: Set<string>): void {
  for (const [id, e] of entries) if (e.sessionId === sessionId && !pendingIds.has(id)) entries.delete(id);
}

export function resetForTests(): void {
  entries.clear();
}
