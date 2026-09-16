import type { Migration } from './index.js';

/**
 * One-line, human-set description of what an agent group is for.
 *
 * Read by claude-md-compose.ts's "available agents" fragment: for every
 * agent-type destination a group has, the target's description is what
 * tells the sending agent when to route to it. NULL means no description
 * has been set yet — the fragment renders a placeholder in that case
 * rather than omitting the row, so the gap is visible instead of silent.
 */
export const migration032: Migration = {
  version: 32,
  name: 'agent-group-description',
  up(db) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN description TEXT;`);
  },
};
