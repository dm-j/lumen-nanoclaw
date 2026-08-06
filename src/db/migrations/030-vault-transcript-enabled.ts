import type { Migration } from './index.js';

/**
 * Schema for the `vault-transcript` module (src/modules/vault-transcript/).
 *
 * `vault_transcript_enabled` — presence of a row = this agent group's turns
 * get exported to its vault via `transcript-append-host`. Absence = the
 * module's per-turn hooks no-op before ever touching execHostShim, even if
 * the group happens to have a seeded (but unconfigured) shim script.
 *
 * Was previously "no table, no flag" — every group got the shim script
 * seeded and the export call fired unconditionally, relying on
 * execHostShim's no-op-if-script-missing and an unset VAULT_PATH failing
 * quietly. That meant every new agent group (including create_agent
 * subagents) logged a `transcript-append failed: VAULT_PATH not configured`
 * warning on every turn until someone noticed and deleted the shim by hand.
 * Same fix shape as migration 025's `projected_sessions_enabled` — a
 * dedicated flag table, not a `container_configs` column.
 */
export const migration030: Migration = {
  version: 30,
  name: 'vault-transcript-enabled',
  up(db) {
    db.exec(`
      CREATE TABLE vault_transcript_enabled (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
        enabled_at TEXT NOT NULL
      );
    `);
  },
};
