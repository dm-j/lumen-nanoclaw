import { beforeEach, describe, expect, it } from 'vitest';

import {
  isHeld,
  isOrderedChannel,
  isTransientDeliveryError,
  pruneSession,
  recordDone,
  recordFailure,
  resetForTests,
  retryDelayMs,
} from './delivery-retry.js';

beforeEach(resetForTests);

// Stand-in with the real adapter class's name (verified: constructor.name === 'NetworkError').
class NetworkError extends Error {
  constructor(_adapter: string, message: string) {
    super(message);
  }
}
class AdapterRateLimitError extends Error {}

describe('retry delay', () => {
  it('grows 5s per failure and holds at 60s', () => {
    expect([1, 2, 3, 11, 12, 13, 50].map(retryDelayMs)).toEqual([5000, 10000, 15000, 55000, 60000, 60000, 60000]);
  });
});

describe('ordering gate', () => {
  it('holds a message during its own backoff, then releases it', () => {
    recordFailure('a', 's', '2026-01-01T00:00:01Z', 1000);
    expect(isHeld('a', '2026-01-01T00:00:01Z', 5999)).toBe(true);
    expect(isHeld('a', '2026-01-01T00:00:01Z', 6000)).toBe(false);
  });

  it('holds later messages while an earlier one retries, with no delay of their own', () => {
    recordFailure('a', 's', '2026-01-01T00:00:01Z', 1000);
    expect(isHeld('b', '2026-01-01T00:00:02Z', 1001)).toBe(true);
    expect(isHeld('earlier', '2026-01-01T00:00:00Z', 1001)).toBe(false); // earlier than the blocker is not held
    recordDone('a');
    expect(isHeld('b', '2026-01-01T00:00:02Z', 1002)).toBe(false); // released immediately
  });

  it('a released message that fails starts its own backoff at 5s', () => {
    recordFailure('a', 's', '2026-01-01T00:00:01Z', 0);
    recordFailure('a', 's', '2026-01-01T00:00:01Z', 5000); // a is now at 10s
    recordDone('a');
    expect(recordFailure('b', 's', '2026-01-01T00:00:02Z', 6000)).toEqual({ failures: 1, delayMs: 5000 });
  });

  it('prune drops entries whose message is no longer pending', () => {
    recordFailure('a', 's', '2026-01-01T00:00:01Z', 0);
    pruneSession('s', new Set());
    expect(isHeld('b', '2026-01-01T00:00:02Z', 1)).toBe(false);
  });
});

describe('classification', () => {
  it('retries the adapter NetworkError, not arbitrary errors', () => {
    expect(isTransientDeliveryError(new NetworkError('telegram', 'x'))).toBe(true);
    expect(isTransientDeliveryError(new AdapterRateLimitError('429'))).toBe(true);
    expect(isTransientDeliveryError(new Error('chat not found'))).toBe(false);
    expect(isOrderedChannel('telegram')).toBe(true);
    expect(isOrderedChannel('discord')).toBe(false);
  });
});
