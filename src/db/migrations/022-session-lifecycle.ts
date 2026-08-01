import type { Migration } from './index.js';

/**
 * Per-agent-group session lifecycle on `container_configs`.
 *
 * NULL / 'resumed' = pre-feature behavior: the responder resumes its own
 * ever-growing provider transcript every turn (unchanged default). 'projected'
 * opts a group into the briefing-compiler model (Obsidian note "Lumen on
 * NanoClaw — Projected Session Implementation Plan", Phase 1): the responder
 * never resumes; it gets a compiled briefing + a literal recent-turns tail
 * instead of full history.
 */
export const migration022: Migration = {
  version: 22,
  name: 'session-lifecycle',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN session_lifecycle TEXT;`);
  },
};
