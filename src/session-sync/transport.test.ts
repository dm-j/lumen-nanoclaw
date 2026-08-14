import { describe, expect, it } from 'vitest';

import { signToken, verifyToken } from './transport.js';

describe('signToken/verifyToken', () => {
  it('round-trips a valid token', () => {
    const token = signToken('sess-1', 'secret-a', 60_000);
    expect(verifyToken(token, 'secret-a')).toBe('sess-1');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken('sess-1', 'secret-a', 60_000);
    expect(verifyToken(token, 'secret-b')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signToken('sess-1', 'secret-a', -1);
    expect(verifyToken(token, 'secret-a')).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyToken('not.a.valid.token', 'secret-a')).toBeNull();
    expect(verifyToken('garbage', 'secret-a')).toBeNull();
  });

  it('rejects a tampered sessionId', () => {
    const token = signToken('sess-1', 'secret-a', 60_000);
    const [, expiry, sig] = token.split('.');
    expect(verifyToken(`sess-evil.${expiry}.${sig}`, 'secret-a')).toBeNull();
  });
});
