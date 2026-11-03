/**
 * Expire module approvals nobody answered.
 *
 * `requestApproval` stamps `expires_at` = now + APPROVAL_TTL_MS. Once past it, the
 * host sweep drops the row and tells the requesting agent, so a missed or lost
 * card can't leave a request pending (and its workflow stuck) forever. Rows from
 * before the TTL existed have no `expires_at`; they age out from `created_at`.
 *
 * OneCLI credential rows are skipped: their `expires_at` is the gateway's own
 * request TTL and onecli-approvals.ts expires them (with a card edit) itself.
 * "Reject with reason…" holds are status 'awaiting_reason', not 'pending', and
 * have their own sweep in reason-capture.ts.
 */
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApprovals, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { ONECLI_ACTION } from './onecli-approvals.js';
import { APPROVAL_TTL_MS, notifyApprovalResolved } from './primitive.js';

function deadlineMs(approval: PendingApproval): number {
  return approval.expires_at
    ? new Date(approval.expires_at).getTime()
    : new Date(approval.created_at).getTime() + APPROVAL_TTL_MS;
}

export async function sweepExpiredApprovals(): Promise<void> {
  const nowMs = Date.now();
  for (const approval of getPendingApprovals()) {
    if (approval.action === ONECLI_ACTION || deadlineMs(approval) > nowMs) continue;

    const session = approval.session_id ? getSession(approval.session_id) : null;
    deletePendingApproval(approval.approval_id);
    if (!session) continue;

    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Your ${approval.action} request expired unanswered; nothing was applied. Do not re-request it unless the user asks again.`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    log.info('Approval expired unanswered', { approvalId: approval.approval_id, action: approval.action });
    await notifyApprovalResolved({ approval, session, outcome: 'reject', userId: '' });
    await wakeContainer(session);
  }
}
