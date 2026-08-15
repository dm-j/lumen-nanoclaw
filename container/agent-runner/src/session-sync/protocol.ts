/**
 * Wire protocol for the 'sync' session transport (container side).
 *
 * Mirror of src/session-sync/protocol.ts on the host — no shared modules
 * cross the host/container boundary (same convention as self-mod.ts
 * duplicating claude-md-compose.ts's MCP-name validation). Keep the two in
 * sync by hand.
 *
 * Not yet used by any live path — see host-side file header for phase status.
 */
import { createHash } from 'node:crypto';

export type SyncMessageKind =
  | 'inbound'
  | 'outbound'
  | 'ack'
  | 'ack_processing'
  | 'session_state'
  | 'container_state';

export interface SyncMessage {
  seq: number;
  kind: SyncMessageKind;
  /** Hash-chain value at this message: hash(prevChain + seq + canonicalize(payload)). */
  chain: string;
  payload: unknown;
}

/** Chain value for the first message in a session — no predecessor to fold in. */
export const GENESIS_CHAIN = '0'.repeat(64);

/**
 * Deterministic JSON serialization for hashing: sorted keys at every level,
 * so two structurally-identical payloads always hash the same regardless of
 * property insertion order (JSON.stringify alone doesn't guarantee this).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Next chain value given the previous chain value, this message's seq, and
 * its payload. `seq` is folded in (not just the payload) so a message with
 * a correct payload chain but a forged/wrong `seq` is rejected too — seq is
 * what callers use as the resync bookmark, so it must be as tamper-evident
 * as the payload itself.
 */
export function nextChain(prevChain: string, seq: number, payload: unknown): string {
  return createHash('sha256').update(prevChain).update(String(seq)).update(canonicalize(payload)).digest('hex');
}

/**
 * Verify one message against the chain. Returns the next chain value on
 * success (caller advances its running chain), or `null` on mismatch — the
 * caller must not apply the message and should request resync from its last
 * known-good seq/chain.
 */
export function verifyChain(prevChain: string, message: SyncMessage): string | null {
  const expected = nextChain(prevChain, message.seq, message.payload);
  return expected === message.chain ? expected : null;
}
