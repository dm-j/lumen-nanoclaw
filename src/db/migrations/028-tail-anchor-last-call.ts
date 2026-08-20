import type { Migration } from './index.js';

/**
 * Adds wall-clock "last call" timestamps to the two tail-anchor lanes on
 * `session_briefings` (migration 025). The existing anchor/count columns
 * track turn-count growth (N→2N truncate) but have no notion of elapsed
 * time, so a long gap between turns lets the anchor keep growing even
 * though Anthropic's prompt cache (TTL-based, not turn-count-based) has
 * already gone cold — the eventual rebuild pays full price for a bigger
 * tail than N. These columns let `renderLiteralTail` also reset on a stale
 * cache, independent of the 2N turn-count trigger.
 */
export const migration028: Migration = {
  version: 28,
  name: 'tail-anchor-last-call',
  up(db) {
    db.exec(`
      ALTER TABLE session_briefings ADD COLUMN compiler_last_call_at TEXT;
      ALTER TABLE session_briefings ADD COLUMN responder_last_call_at TEXT;
    `);
  },
};
