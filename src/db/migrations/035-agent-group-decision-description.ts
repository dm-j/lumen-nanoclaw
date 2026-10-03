import type { Migration } from './index.js';

/**
 * An agent's own description of itself, written as one option in a list for a
 * "decision model" (Jev-style): a model that scores a request against a list of
 * short text options in a single pass and returns typed probabilities, instead
 * of generating text. The router builds the option list from these strings, one
 * per agent group, so each must stand alone and discriminate: what the agent
 * handles and, where it helps, what it does not.
 *
 * Separate from `description` on purpose. `description` is a routing hint an LLM
 * coordinator (Dispatcher) reads in its "available agents" table; this is
 * scored, not read, and is tuned for a different consumer. NULL means the agent
 * has not described itself yet; a decision router should skip such a group
 * rather than invent an option for it.
 */
export const migration035: Migration = {
  version: 35,
  name: 'agent-group-decision-description',
  up(db) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN decision_description TEXT;`);
  },
};
