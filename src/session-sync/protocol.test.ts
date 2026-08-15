import { describe, it, expect } from 'vitest';

import { GENESIS_CHAIN, nextChain, verifyChain, canonicalize } from './protocol.js';

describe('session-sync protocol: hash chain', () => {
  it('canonicalizes regardless of key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('builds a verifiable chain across multiple messages', () => {
    let chain = GENESIS_CHAIN;
    const payloads = [
      { seq: 1, text: 'hello' },
      { seq: 2, text: 'world' },
      { seq: 3, text: 'ok' },
    ];
    for (const payload of payloads) {
      const expected = nextChain(chain, payload.seq, payload);
      const verified = verifyChain(chain, { seq: payload.seq, kind: 'inbound', chain: expected, payload });
      expect(verified).toBe(expected);
      chain = verified!;
    }
  });

  it('detects a tampered payload', () => {
    const chain = nextChain(GENESIS_CHAIN, 1, { text: 'original' });
    const result = verifyChain(GENESIS_CHAIN, {
      seq: 1,
      kind: 'inbound',
      chain,
      payload: { text: 'tampered' },
    });
    expect(result).toBeNull();
  });

  it('detects a chain broken by a missing/reordered predecessor', () => {
    const chainA = nextChain(GENESIS_CHAIN, 1, { i: 1 });
    const chainB = nextChain(chainA, 2, { i: 2 });
    // Verifying message B against GENESIS instead of chainA (as if message A
    // never arrived) must fail, not silently accept.
    const result = verifyChain(GENESIS_CHAIN, { seq: 2, kind: 'inbound', chain: chainB, payload: { i: 2 } });
    expect(result).toBeNull();
  });

  it('detects a forged seq with an otherwise-correct payload chain', () => {
    const chain = nextChain(GENESIS_CHAIN, 1, { text: 'hello' });
    // Same payload, same resulting chain value, but claiming a different seq —
    // must not verify, since seq is the resync bookmark and must be tamper-evident.
    const result = verifyChain(GENESIS_CHAIN, { seq: 999, kind: 'inbound', chain, payload: { text: 'hello' } });
    expect(result).toBeNull();
  });
});
