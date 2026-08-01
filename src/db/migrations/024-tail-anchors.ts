import type { Migration } from './index.js';

/**
 * Prefix-cache-aware literal-tail anchor state for `session_briefings`
 * (Implementation Plan §4c). Two independent lanes — compiler and responder
 * each run their own N→2N→truncate growth cycle with their own N, so each
 * gets its own anchor timestamp + running count.
 *
 * anchor_ts = timestamp of the oldest turn included in last call's tail
 * (the fixed start point new turns append after). NULL = no anchor yet
 * (first call, or just reset) — the next read establishes one.
 * anchor_count = how many turns were included last call, checked against
 * 2×N to decide whether to reset the anchor forward.
 */
export const migration024: Migration = {
  version: 24,
  name: 'tail-anchors',
  up(db) {
    db.exec(`
      ALTER TABLE session_briefings ADD COLUMN compiler_anchor_ts TEXT;
      ALTER TABLE session_briefings ADD COLUMN compiler_anchor_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_briefings ADD COLUMN responder_anchor_ts TEXT;
      ALTER TABLE session_briefings ADD COLUMN responder_anchor_count INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
