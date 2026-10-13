import type { Migration } from './index.js';

/**
 * Per-agent-group opt-in for the self-cancelling follow-up timer
 * (`set_followup` MCP tool, src/modules/followup/). 0 = off (default).
 */
export const migration036: Migration = {
  version: 36,
  name: 'followup-enabled',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN followup_enabled INTEGER NOT NULL DEFAULT 0;`);
  },
};
