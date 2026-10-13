/** Side-effect-free half of the followup module — safe for router.ts to import. */
import { openInboundDb } from '../../session-manager.js';
import { notifyInboundWrite, type InboundRowPayload } from '../../session-sync/inbound-push.js';

export const FOLLOWUP_ID_PREFIX = 'followup-';

/** Cancel every still-pending follow-up in a session. Returns how many were cancelled. */
export function cancelFollowups(agentGroupId: string, sessionId: string): number {
  const db = openInboundDb(agentGroupId, sessionId);
  let rows: InboundRowPayload[] = [];
  try {
    const ids = (
      db.prepare("SELECT id FROM messages_in WHERE id LIKE 'followup-%' AND status = 'pending'").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    for (const id of ids) {
      db.prepare("UPDATE messages_in SET status = 'cancelled' WHERE id = ?").run(id);
      rows.push(db.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as InboundRowPayload);
    }
  } finally {
    db.close();
  }
  // 'sync' transport: the container's local copy still says 'pending' until pushed.
  for (const r of rows) notifyInboundWrite(agentGroupId, sessionId, r);
  return rows.length;
}
