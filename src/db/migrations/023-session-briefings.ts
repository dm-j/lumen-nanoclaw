import type { Migration } from './index.js';

/**
 * Host-side rolling briefing storage for `session_lifecycle = 'projected'`
 * sessions (Implementation Plan §2). Deliberately NOT `outbound.db.session_state`
 * — that's container-owned and only exists once a container has run; the host
 * needs to read/write this before deciding whether to spawn one at all.
 *
 * `session_key` mirrors the key that already resolves a `sessions` row:
 * `<agent_group_id>` alone (agent-shared) or `<agent_group_id>:<messaging_group_id>[:<thread_id>]`
 * (shared / per-thread) — built by `src/modules/synthetic-context/compile-briefing.ts`.
 */
export const migration023: Migration = {
  version: 23,
  name: 'session-briefings',
  up(db) {
    db.exec(`
      CREATE TABLE session_briefings (
        session_key TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `);
  },
};
