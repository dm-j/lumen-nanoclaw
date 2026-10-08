import { afterEach, describe, expect, test } from 'bun:test';

import { cacheSessionId, contextDelta, projectedResetReason, queryCacheLive } from './projected-sessions.js';

const base = { followUpsPushed: 0, maxFollowUps: 12, idleMs: 0, cacheLive: true, fallbackTtlMs: 300_000 };

describe('projectedResetReason', () => {
  test('keeps a warm query while the cache is live and under the cap', () => {
    expect(projectedResetReason({ ...base, followUpsPushed: 11, idleMs: 3_600_000 })).toBeNull();
  });
  test('resets at the follow-up cap even if the cache is live', () => {
    expect(projectedResetReason({ ...base, followUpsPushed: 12 })).toContain('12 follow-ups');
  });
  test('resets when the provider cache has expired', () => {
    expect(projectedResetReason({ ...base, cacheLive: false })).toContain('expired');
  });
  test('unknown cache status falls back to idle time', () => {
    expect(projectedResetReason({ ...base, cacheLive: null, idleMs: 299_000 })).toBeNull();
    expect(projectedResetReason({ ...base, cacheLive: null, idleMs: 301_000 })).toContain('fallback');
  });
});

describe('cacheSessionId', () => {
  test('parses the host-set header', () => {
    expect(cacheSessionId('x-session-id: ag-1:mg-2:th-3')).toBe('ag-1:mg-2:th-3');
    expect(cacheSessionId('X-Other: a\nx-session-id:  k ')).toBe('k');
  });
  test('absent -> null', () => {
    expect(cacheSessionId(undefined)).toBeNull();
    expect(cacheSessionId('x-other: a')).toBeNull();
  });
});

describe('queryCacheLive', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const reply = (body: unknown, ok = true) => (globalThis.fetch = (async () => ({ ok, json: async () => body })) as never);

  test('maps live/expired/unknown', async () => {
    reply({ cache: 'live' });
    expect(await queryCacheLive('m', 'http://x', 's')).toBe(true);
    reply({ cache: 'expired' });
    expect(await queryCacheLive('m', 'http://x', 's')).toBe(false);
    reply({ cache: '???' });
    expect(await queryCacheLive('m', 'http://x', 's')).toBeNull();
  });
  test('non-200, network error and missing inputs are unknown', async () => {
    reply({}, false);
    expect(await queryCacheLive('m', 'http://x', 's')).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error('down');
    }) as never;
    expect(await queryCacheLive('m', 'http://x', 's')).toBeNull();
    expect(await queryCacheLive(undefined, 'http://x', 's')).toBeNull();
    expect(await queryCacheLive('m', 'http://x', null)).toBeNull();
  });
});

describe('contextDelta', () => {
  const blocks = (...b: string[]) => new Set(b);
  const prev = { briefing: 'B1', blocks: blocks('> [t1] A:\n> one', '> [t2] B:\n> two') };
  const tail = (...b: string[]) => b.join('\n\n');

  test('first prompt of a query gets everything', () => {
    expect(contextDelta(null, { briefing: 'B1', tail: tail('x', 'y') })).toEqual({ briefing: 'B1', tail: tail('x', 'y') });
  });
  test('follow-up with nothing new sends nothing', () => {
    expect(contextDelta(prev, { briefing: 'B1', tail: tail('> [t1] A:\n> one', '> [t2] B:\n> two') })).toEqual({ briefing: '', tail: '' });
  });
  test('a grown tail sends only the new turn blocks; a changed briefing is resent whole', () => {
    expect(contextDelta(prev, { briefing: 'B2', tail: tail('> [t1] A:\n> one', '> [t2] B:\n> two', '> [t3] C:\n> three') })).toEqual({
      briefing: 'B2',
      tail: '> [t3] C:\n> three',
    });
  });
  test('a SLID tail (oldest dropped, newest added -- not an extension of the old text) still sends only the new block', () => {
    expect(contextDelta(prev, { briefing: 'B1', tail: tail('> [t2] B:\n> two', '> [t3] C:\n> three') })).toEqual({ briefing: '', tail: '> [t3] C:\n> three' });
  });
  test('an edited turn counts as new', () => {
    expect(contextDelta(prev, { briefing: 'B1', tail: tail('> [t1] A:\n> one (edited)', '> [t2] B:\n> two') }).tail).toBe('> [t1] A:\n> one (edited)');
  });
});
