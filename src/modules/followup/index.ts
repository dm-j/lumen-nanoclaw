/**
 * followup module — a self-cancelling "check back in N minutes" timer for
 * opted-in agent groups (`container_configs.followup_enabled`).
 *
 * `set_followup` inserts one due `chat` row into the agent's own session
 * (id `followup-…`); a real inbound user message cancels it (router.ts calls
 * `cancelFollowups`), so the timer only fires if the user stayed silent. Unlike
 * `ncl tasks` (isolated session, never cancelled by a reply) this lands in the
 * live conversation and lets silence — not a clock alone — decide.
 *
 * One live follow-up per session: setting a new one replaces the old.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { cancelFollowups, FOLLOWUP_ID_PREFIX } from './cancel.js';

export const MAX_FOLLOWUP_MINUTES = 24 * 60;

registerDeliveryAction(
  'set_followup',
  async (content, session, inDb) => {
    if (getContainerConfig(session.agent_group_id)?.followup_enabled !== 1) {
      log.warn('set_followup from a group without followup_enabled — dropped', { sessionId: session.id });
      return;
    }
    const minutes = Number(content.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_FOLLOWUP_MINUTES) return;
    const note = typeof content.note === 'string' ? content.note.slice(0, 2000) : '';

    // Route the wake like the conversation it belongs to: copy the latest chat row's address.
    const addr = inDb
      .prepare(
        "SELECT platform_id, channel_type, thread_id FROM messages_in WHERE kind IN ('chat','chat-sdk') AND channel_type IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get() as { platform_id: string; channel_type: string; thread_id: string | null } | undefined;
    if (!addr) {
      log.warn('set_followup: session has no chat message to take routing from', { sessionId: session.id });
      return;
    }

    cancelFollowups(session.agent_group_id, session.id);
    const now = new Date();
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `${FOLLOWUP_ID_PREFIX}${now.getTime()}`,
      kind: 'chat',
      timestamp: now.toISOString(),
      platformId: addr.platform_id,
      channelType: addr.channel_type,
      threadId: addr.thread_id,
      content: JSON.stringify({
        sender: 'Follow-up timer',
        text:
          `[Your follow-up timer set at ${now.toISOString()} for ${minutes} min has fired — no message has arrived since.` +
          ` This is not from the user.]` +
          (note ? `\nNote to self: ${note}` : ''),
      }),
      processAfter: new Date(now.getTime() + minutes * 60_000).toISOString(),
    });
    log.info('Follow-up set', { sessionId: session.id, minutes });
  },
  unguarded('only schedules a message into the caller’s own session; group must opt in via followup_enabled'),
);

registerDeliveryAction(
  'clear_followup',
  async (_content, session) => {
    cancelFollowups(session.agent_group_id, session.id);
  },
  unguarded('only cancels the caller’s own session timer'),
);
