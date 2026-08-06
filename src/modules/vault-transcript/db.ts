/**
 * Enablement flag for the vault-transcript module. Owns one table
 * (migration 030) — mirrors projected-sessions/db.ts's shape exactly.
 */
import { getDb } from '../../db/connection.js';

export function isEnabled(agentGroupId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM vault_transcript_enabled WHERE agent_group_id = ?').get(agentGroupId);
  return row !== undefined;
}

export function setEnabled(agentGroupId: string, enabled: boolean): void {
  if (enabled) {
    getDb()
      .prepare(
        `INSERT INTO vault_transcript_enabled (agent_group_id, enabled_at) VALUES (?, ?)
         ON CONFLICT(agent_group_id) DO NOTHING`,
      )
      .run(agentGroupId, new Date().toISOString());
  } else {
    getDb().prepare('DELETE FROM vault_transcript_enabled WHERE agent_group_id = ?').run(agentGroupId);
  }
}

export function listEnabled(): string[] {
  return (
    getDb().prepare('SELECT agent_group_id FROM vault_transcript_enabled').all() as Array<{
      agent_group_id: string;
    }>
  ).map((r) => r.agent_group_id);
}
