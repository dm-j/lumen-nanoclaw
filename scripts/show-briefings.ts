/**
 * scripts/show-briefings.ts — print the last N compiled briefings for an
 * agent group, newest first. Read-only ops tool for eyeballing briefing
 * quality (e.g. after swapping inference providers/models) without having
 * to infer it secondhand from the responder's replies.
 *
 * Usage: ./show-briefings.sh <agent-group-name-or-folder-or-id> [N=5]
 */
import Database from 'better-sqlite3';
import path from 'path';

const [, , groupArg, nArg] = process.argv;
if (!groupArg) {
  console.error('Usage: show-briefings.sh <agent-group-name-or-folder-or-id> [N=5]');
  process.exit(2);
}
const limit = Number(nArg) > 0 ? Number(nArg) : 5;

const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = new Database(dbPath, { readonly: true });

const group = db
  .prepare('SELECT id, name, folder FROM agent_groups WHERE id = ? OR name = ? OR folder = ?')
  .get(groupArg, groupArg, groupArg) as { id: string; name: string; folder: string } | undefined;

if (!group) {
  console.error(`No agent group matching "${groupArg}" (checked id, name, folder).`);
  db.close();
  process.exit(1);
}

// session_key is either the bare agent_group_id (agent-shared sessions) or
// "<agentGroupId>:<messagingGroupId>[:<threadId>]" — see
// compile-briefing.ts's sessionBriefingKey. Both shapes match here.
const rows = db
  .prepare(
    `SELECT session_key, content, created_at FROM session_briefing_history
     WHERE session_key = ? OR session_key LIKE ?
     ORDER BY created_at DESC LIMIT ?`,
  )
  .all(group.id, `${group.id}:%`, limit) as Array<{ session_key: string; content: string; created_at: string }>;

db.close();

if (rows.length === 0) {
  console.log(`No briefing history for "${group.name}" (${group.id}) — projected sessions may not be enabled, or no turns compiled yet.`);
  process.exit(0);
}

for (const r of rows) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${r.created_at}  session_key=${r.session_key}`);
  console.log('='.repeat(72));
  console.log(r.content);
}
