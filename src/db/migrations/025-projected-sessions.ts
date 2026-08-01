import type { Migration } from './index.js';

/**
 * Schema for the `projected-sessions` module (src/modules/projected-sessions/).
 *
 * `projected_sessions_enabled` — presence of a row = this agent group is on
 * the projected lifecycle (compiled briefing + literal tail replace provider
 * transcript resume). Absence = default 'resumed' behavior, completely
 * untouched. A dedicated flag table rather than a column on `container_configs`
 * — keeps this module's schema fully self-contained (own migration, own
 * table, own CRUD), matching the shape `agent_destinations` already uses for
 * an optional module (see migration 004, `module-agent-to-agent-destinations.ts`).
 *
 * `session_briefings` — host-side rolling briefing + prefix-cache-aware
 * literal-tail anchor state per session key. `session_key` mirrors the key
 * that already resolves a `sessions` row: `<agent_group_id>` alone
 * (agent-shared) or `<agent_group_id>:<messaging_group_id>[:<thread_id>]`
 * (shared / per-thread). Anchor columns are two independent lanes —
 * compiler and responder each run their own N→2N→truncate growth cycle.
 */
export const migration025: Migration = {
  version: 25,
  name: 'projected-sessions',
  up(db) {
    db.exec(`
      CREATE TABLE projected_sessions_enabled (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
        enabled_at TEXT NOT NULL
      );
      CREATE TABLE session_briefings (
        session_key TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        compiler_anchor_ts TEXT,
        compiler_anchor_count INTEGER NOT NULL DEFAULT 0,
        responder_anchor_ts TEXT,
        responder_anchor_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};
