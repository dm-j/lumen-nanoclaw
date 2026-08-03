import type { Migration } from './index.js';

/**
 * `session_briefing_history` — rolling window of past compiled briefings per
 * session key, oldest-first insertion order via `seq`. Separate from
 * `session_briefings.content` (still the single "current" briefing used as
 * the compiler's PREV_FILE input and the responder's briefing.md) — this
 * table exists purely to bound how many past briefings ever get shown in
 * either side's literal tail, independent of that current-briefing value.
 */
export const migration027: Migration = {
  version: 27,
  name: 'briefing-history',
  up(db) {
    db.exec(`
      CREATE TABLE session_briefing_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX session_briefing_history_session_key_seq
        ON session_briefing_history (session_key, seq);
    `);
  },
};
