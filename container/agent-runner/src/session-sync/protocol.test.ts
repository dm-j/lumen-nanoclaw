import { describe, it, expect } from 'bun:test';

import { GENESIS_CHAIN, nextChain, verifyChain, canonicalize } from './protocol.js';

describe('session-sync protocol: hash chain (container)', () => {
  it('canonicalizes regardless of key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('builds a verifiable chain across multiple messages', () => {
    let chain = GENESIS_CHAIN;
    const payloads = [{ seq: 1, text: 'hello' }, { seq: 2, text: 'world' }, { seq: 3, text: 'ok' }];
    for (const payload of payloads) {
      const expected = nextChain(chain, payload);
      const verified = verifyChain(chain, { seq: payload.seq, kind: 'outbound', chain: expected, payload });
      expect(verified).toBe(expected);
      chain = verified!;
    }
  });

  it('detects a tampered payload', () => {
    const chain = nextChain(GENESIS_CHAIN, { text: 'original' });
    const result = verifyChain(GENESIS_CHAIN, {
      seq: 1,
      kind: 'outbound',
      chain,
      payload: { text: 'tampered' },
    });
    expect(result).toBeNull();
  });
});
