import type { Migration } from './index.js';

/**
 * What a "decision model" (Jev-style) scores against a request: one short text
 * option per agent group, answering a single question, "is this agent the best
 * handler for the current request?" The model scores a request against a list of
 * such options in one pass and returns typed probabilities; it does not read prose.
 *
 * So the text is a criterion, not a profile. Say what makes this agent the best
 * choice, and include what the agent does only to the extent it helps answer that
 * question (a capability that never decides the choice is noise, and it dilutes the
 * score). Contrast with the agents it is most easily confused with where that is
 * what settles the call. Each string must stand alone, since it is scored without the others.
 *
 * Separate from `description`, which an LLM coordinator (Dispatcher) reads as a
 * routing hint. NULL means the agent has not written one yet; a decision router
 * should skip such a group rather than invent an option for it.
 */
export const migration035: Migration = {
  version: 35,
  name: 'agent-group-decision-description',
  up(db) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN decision_description TEXT;`);
  },
};
