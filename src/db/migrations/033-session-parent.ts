import type { Migration } from './index.js';

/**
 * Links a session created by `assign_task` back to the session that
 * assigned it — the parent's own task session (or main session, for a
 * top-level assignment). NULL for every session created any other way
 * (scheduled tasks, channel-originated sessions, the old 'agent-shared'
 * reuse path).
 *
 * Lets a delegation tree be walked (which session assigned this one?) and
 * is the scoping key for report_completion's session-closure: only a
 * session with a non-NULL parent_session_id is safe to close on its own
 * completion, since only assign_task-created sessions are guaranteed
 * dedicated to one work order. See docs/roadmap/task-id-routing-spike.md.
 */
export const migration033: Migration = {
  version: 33,
  name: 'session-parent',
  up(db) {
    db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;`);
  },
};
