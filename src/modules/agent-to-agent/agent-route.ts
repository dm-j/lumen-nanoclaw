/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { ensureContainedInboxDir, isPathInside } from '../../inbox-safety.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getInboundSourceSessionId, getMostRecentPeerSourceSessionId } from '../../db/session-db.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { GuardDenyError, guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { openInboundDb, resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION, a2aSend } from './guard.js';

export { isSafeAttachmentName };
export { A2A_MESSAGE_GATE_ACTION } from './guard.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  if (!isSafeAttachmentName(source.messageId)) {
    log.warn('agent-route: rejecting unsafe source outbox message id', { sourceMsgId: source.messageId });
    return [];
  }

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  let realSourceDir: string;
  try {
    const sourceDirStat = fs.lstatSync(sourceDir);
    if (!sourceDirStat.isDirectory() || sourceDirStat.isSymbolicLink()) {
      log.warn('agent-route: rejecting unsafe source outbox dir', {
        sourceMsgId: source.messageId,
        sourceDir,
      });
      return [];
    }
    realSourceDir = fs.realpathSync(sourceDir);
  } catch (err) {
    log.warn('agent-route: failed to inspect source outbox dir', {
      sourceMsgId: source.messageId,
      sourceDir,
      err,
    });
    return [];
  }

  // Target-side containment — shared with the channel-inbound path. A
  // compromised target agent can write inside its own session dir, so it could
  // pre-place `inbox` (or `inbox/<future-msgId>`) as a symlink pointing
  // anywhere host-writable; ensureContainedInboxDir refuses the symlink before
  // any copy lands outside the sandbox (#2828, CWE-59).
  const inboxRoot = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox');
  const targetInboxDir = ensureContainedInboxDir(inboxRoot, target.messageId, {
    targetGroup: target.agentGroupId,
    targetSession: target.sessionId,
    targetMsgId: target.messageId,
  });
  if (!targetInboxDir) {
    return [];
  }

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    let realSrc: string;
    try {
      const srcStat = fs.lstatSync(src);
      if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
        log.warn('agent-route: rejecting unsafe source outbox file', {
          sourceMsgId: source.messageId,
          filename,
        });
        continue;
      }
      realSrc = fs.realpathSync(src);
    } catch {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    if (!isPathInside(realSourceDir, realSrc)) {
      log.warn('agent-route: rejecting source file outside source outbox dir', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    try {
      // COPYFILE_EXCL: fail with EEXIST rather than follow or overwrite a
      // pre-placed symlink / existing file at dst — the host is the sole
      // writer of these attachments.
      fs.copyFileSync(realSrc, dst, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      log.warn('agent-route: refusing to write target inbox file', {
        sourceMsgId: source.messageId,
        targetMsgId: target.messageId,
        filename,
        err,
      });
      continue;
    }
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
  /**
   * For replies, the id of the inbound message being replied to. The
   * container's formatter sets this from the first inbound in the batch
   * (`container/agent-runner/src/formatter.ts`). Used here to route the
   * reply back to the originating session — see `resolveTargetSession`.
   */
  in_reply_to: string | null;
}

/**
 * Pick which session of `targetAgentGroupId` should receive this a2a message.
 *
 * Three layers, highest-fidelity first:
 *
 * 1. **Direct return-path** (in_reply_to lookup): if the message is a reply
 *    (`in_reply_to` set), open the source agent's inbound DB and read the
 *    triggering row's `source_session_id`. That column was stamped when the
 *    original outbound was routed — it's the session that started the
 *    conversation, and replies should land there even when the target has
 *    multiple active sessions.
 *
 * 2. **Peer-affinity fallback**: if (1) misses (in_reply_to is null or the
 *    referenced row isn't an a2a inbound), look up the most recent a2a
 *    inbound *from the target agent group* in source's inbound and use its
 *    `source_session_id`. The intuition: the last time this peer talked to
 *    me, which target session was driving? Route the reply there, since
 *    that's the session most plausibly in active conversation.
 *
 * 3. **Newest active session**: legacy heuristic. Used when no prior a2a
 *    has been recorded with `source_session_id` (e.g. fresh installs,
 *    pre-migration data).
 *
 * NOTE: closed-session enforcement (bouncing a message aimed at a closed
 * exact-match candidate instead of falling through to (3)) was tried and
 * reverted same day (2026-09-16) — see docs/roadmap/task-id-routing-spike.md
 * "Addendum: report_completion session-closure reverted". Its precondition
 * (each work order tracked in its own dedicated session) isn't built yet;
 * today, Routine/Computation/Dispatcher each share ONE long-lived a2a
 * session across every unrelated work order, so closing "the caller's
 * session" on one work order's report_completion would silently kill that
 * agent's ability to receive any further delegation, not just close out
 * the one exchange. Falling through to (3) here is deliberately the
 * simple, safe behavior until task_id-scoped sessions exist.
 */
function resolveTargetSession(msg: RoutableAgentMessage, sourceSession: Session, targetAgentGroupId: string): Session {
  const srcDb = openInboundDb(sourceSession.agent_group_id, sourceSession.id);
  let originSessionId: string | null = null;
  try {
    if (msg.in_reply_to) {
      originSessionId = getInboundSourceSessionId(srcDb, msg.in_reply_to);
    }
    if (!originSessionId) {
      // Peer-affinity fallback — covers the case where the container's
      // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
      // path, container running pre-fix code).
      originSessionId = getMostRecentPeerSourceSessionId(srcDb, targetAgentGroupId);
    }
  } finally {
    srcDb.close();
  }
  if (originSessionId) {
    const candidate = getSession(originSessionId);
    if (candidate && candidate.agent_group_id === targetAgentGroupId && candidate.status === 'active') {
      return candidate;
    }
  }
  return resolveSession(targetAgentGroupId, null, null, 'agent-shared').session;
}

export async function routeAgentMessage(
  msg: RoutableAgentMessage,
  session: Session,
  opts: { grant?: PendingApproval } = {},
): Promise<void> {
  const sourceAgentGroupId = session.agent_group_id;
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }

  // The a2a.send decision (guard.ts) carries the checks verbatim in their
  // original order: destination ACL deny, target-exists deny, self-send
  // allow, agent_message_policies hold. An approved replay carries the
  // grant — the hold is satisfied but the structure is re-checked live, so
  // revoking a destination between hold and approve blocks delivery.
  const decision = guard(a2aSend, {
    actor: { kind: 'agent', agentGroupId: sourceAgentGroupId, sessionId: session.id },
    resource: { from: sourceAgentGroupId, to: targetAgentGroupId },
    payload: { id: msg.id, platform_id: targetAgentGroupId, content: msg.content, in_reply_to: msg.in_reply_to },
    grant: opts.grant ?? null,
  });

  if (decision.effect === 'deny') {
    throw new GuardDenyError(decision.reason);
  }

  // Gated edge: hold the message and return (not throw) so the delivery loop
  // consumes the outbound row; `applyA2aMessageGate` re-enters here with the
  // grant on approve.
  if (decision.effect === 'hold') {
    const sourceName = getAgentGroup(sourceAgentGroupId)?.name ?? sourceAgentGroupId;
    const targetName = getAgentGroup(targetAgentGroupId)?.name ?? targetAgentGroupId;
    await requestApproval({
      session,
      agentName: sourceName,
      action: A2A_MESSAGE_GATE_ACTION,
      approverUserId: decision.approverUserId,
      title: 'Message approval',
      question: buildGateQuestion(sourceName, targetName, msg.content),
      payload: {
        id: msg.id,
        platform_id: targetAgentGroupId,
        content: msg.content,
        in_reply_to: msg.in_reply_to,
      },
    });
    log.info('Agent message held for approval', {
      from: sourceAgentGroupId,
      to: targetAgentGroupId,
      msgId: msg.id,
    });
    return;
  }

  await performAgentRoute(msg, session, targetAgentGroupId);
}

const GATE_CARD_BODY_MAX = 1500;

function parseMessageContent(contentStr: string): { text: string; files: string[] } {
  try {
    const parsed = JSON.parse(contentStr) as { text?: unknown; files?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    };
  } catch {
    return { text: contentStr, files: [] };
  }
}

/** Set/overwrite `content.sender` on a message content JSON string, preserving other fields. */
function withSenderName(contentStr: string, sender: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    parsed = { text: contentStr };
  }
  parsed.sender = sender;
  return JSON.stringify(parsed);
}

function buildGateQuestion(sourceName: string, targetName: string, contentStr: string): string {
  const { text, files } = parseMessageContent(contentStr);
  const body = text.length > GATE_CARD_BODY_MAX ? `${text.slice(0, GATE_CARD_BODY_MAX)}… (truncated)` : text;
  const lines = [`Agent "${sourceName}" wants to send a message to "${targetName}":`, '', body];
  if (files.length > 0) lines.push('', `Attachments: ${files.join(', ')}`);
  lines.push(
    '',
    `Approve, Reject, or "Reject with reason…" to decline and then type a short reason I'll relay to "${sourceName}".`,
  );
  return lines.join('\n');
}

/**
 * Cross-session route: pick the target session, forward files, write to its
 * inbound DB, wake it. Module-private — the only door is routeAgentMessage's
 * guard decision (the approve continuation re-enters with a grant rather
 * than calling this directly).
 */
// Consecutive identical a2a messages from the same source session, on the
// target's own last N inbound turns, before the route is broken instead of
// delivered — a backstop against a confused agent (e.g. one that mistakes
// the other for a human and echoes) looping forever on the same content.
const REPEAT_LOOP_THRESHOLD = 3;

/**
 * True if the target session's last `REPEAT_LOOP_THRESHOLD - 1` a2a inbound
 * messages from this exact source session already carry the same text —
 * meaning this next delivery would be the Nth repeat in a row.
 */
function isRepeatLoop(
  targetAgentGroupId: string,
  targetSessionId: string,
  sourceSessionId: string,
  text: string,
): boolean {
  if (!text) return false;
  const db = openInboundDb(targetAgentGroupId, targetSessionId);
  try {
    const rows = db
      .prepare(
        `SELECT content FROM messages_in
         WHERE kind = 'chat' AND channel_type = 'agent' AND source_session_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(sourceSessionId, REPEAT_LOOP_THRESHOLD - 1) as Array<{ content: string }>;
    if (rows.length < REPEAT_LOOP_THRESHOLD - 1) return false;
    return rows.every((r) => {
      try {
        return (JSON.parse(r.content) as { text?: string }).text === text;
      } catch {
        return false;
      }
    });
  } finally {
    db.close();
  }
}

// Total a2a messages one source session may send to one target session
// before delivery stops — a broader backstop than the repeat-loop check
// above, for a runaway back-and-forth whose content *varies* turn to turn
// (so isRepeatLoop never trips) but never actually resolves anything. 30 is
// meant to comfortably cover a legitimate multi-hop exchange (e.g. Lumen
// asks Dispatcher something, Dispatcher asks for clarification, Lumen
// clarifies, Dispatcher delegates to a specialist) while still catching a
// genuine loop well before it burns unbounded turns.
//
// This counts a *consecutive streak*, not a lifetime total: sessions here
// are long-lived (Dispatcher and Lumen don't get a fresh session per
// exchange), so a raw COUNT(*) would eventually block a pair permanently
// off totally unrelated legitimate traffic over weeks, not just a loop.
// The streak resets the moment anything else lands in the target's inbox —
// the human messaging in, a different agent, anything not this exact source
// session back-to-back — which is exactly what "this exchange never
// resolved" should mean.
const MAX_PAIR_MESSAGES = 30;
// Bounds the backward scan below; matches the safety-cap pattern in
// projected-sessions/literal-tail.ts.
const PAIR_STREAK_SCAN_CAP = 200;

function pairMessageStreak(targetAgentGroupId: string, targetSessionId: string, sourceSessionId: string): number {
  const db = openInboundDb(targetAgentGroupId, targetSessionId);
  try {
    const rows = db
      .prepare(
        `SELECT channel_type, source_session_id FROM messages_in
         WHERE kind = 'chat' ORDER BY seq DESC LIMIT ?`,
      )
      .all(PAIR_STREAK_SCAN_CAP) as Array<{ channel_type: string | null; source_session_id: string | null }>;
    let streak = 0;
    for (const row of rows) {
      if (row.channel_type !== 'agent' || row.source_session_id !== sourceSessionId) break;
      streak++;
    }
    return streak;
  } finally {
    db.close();
  }
}

/** Notify the target session in place of a delivery the caller decided to withhold. */
async function blockDelivery(
  targetAgentGroupId: string,
  targetSession: Session,
  sourceSession: Session,
  reasonText: string,
): Promise<void> {
  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: `a2a-block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: sourceSession.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: withSenderName(JSON.stringify({ text: reasonText }), 'system'),
    sourceSessionId: sourceSession.id,
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * assign_task (core.ts) stamps `assignTaskId` on the outbound content
 * instead of adding a new field to RoutableAgentMessage — the approval-hold
 * replay path (message-gate.ts) only forwards `content` verbatim, so
 * reading it back out of content here means the hold/approve round-trip
 * needs no changes to carry it through.
 */
function assignTaskId(contentStr: string): string | null {
  try {
    const parsed = JSON.parse(contentStr) as { assignTaskId?: unknown };
    return typeof parsed.assignTaskId === 'string' ? parsed.assignTaskId : null;
  } catch {
    return null;
  }
}

async function performAgentRoute(
  msg: RoutableAgentMessage,
  session: Session,
  targetAgentGroupId: string,
): Promise<void> {
  const taskId = assignTaskId(msg.content);
  // assign_task always gets a brand-new, dedicated session — never the
  // reply-chain/peer-affinity/shared-session resolution used for ordinary
  // a2a traffic. That's the entire point: a session created this way is
  // guaranteed scoped to exactly one work order, which is what makes
  // report_completion's session-closure safe to key off parent_session_id
  // (see resolveTargetSession's doc comment for why closure was reverted
  // for the shared-session case).
  const targetSession = taskId
    ? resolveSession(targetAgentGroupId, null, `system:a2a-task:${taskId}`, 'per-thread', session.id).session
    : resolveTargetSession(msg, session, targetAgentGroupId);
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  const sourceName = getAgentGroup(session.agent_group_id)?.name ?? session.agent_group_id;
  // Suffix distinguishes a2a senders from a real human in the same field the
  // formatter renders most prominently (`sender=`) — the "unknown" default
  // that content with no explicit sender used to render as was too easy to
  // mistake for the human on the other end of a fast back-and-forth.
  const contentWithSender = withSenderName(forwardedContent, `${sourceName} (Agent)`);

  if (isRepeatLoop(targetAgentGroupId, targetSession.id, session.id, parseMessageContent(contentWithSender).text)) {
    log.warn('Agent-to-agent repeat loop detected, message dropped', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      msgId: a2aMsgId,
    });
    await blockDelivery(
      targetAgentGroupId,
      targetSession,
      session,
      `Loop detected: the last ${REPEAT_LOOP_THRESHOLD} messages from "${sourceName}" were identical, so this repeat was not delivered. Stop echoing and send something substantive, or drop it.`,
    );
    return;
  }

  const pairCount = pairMessageStreak(targetAgentGroupId, targetSession.id, session.id);
  if (pairCount >= MAX_PAIR_MESSAGES) {
    log.warn('Agent-to-agent pair message limit reached, message dropped', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      msgId: a2aMsgId,
      pairCount,
    });
    await blockDelivery(
      targetAgentGroupId,
      targetSession,
      session,
      `Message limit reached: "${sourceName}" has sent ${pairCount} messages in this exchange without it resolving. This one was not delivered — stop and escalate to a human instead of continuing.`,
    );
    return;
  }

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: contentWithSender,
    sourceSessionId: session.id,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);

  // report_completion closes the *caller's own* session once its final word
  // has actually been delivered (not on the hold/approval path — only
  // here, on real delivery). Gated on parent_session_id rather than just
  // the closesSession flag: only a session created via assign_task is
  // guaranteed dedicated to exactly one work order, so only that kind of
  // session is safe to close on its own completion. Ordinary shared a2a
  // sessions (Routine/Computation's one long-lived session today) have no
  // parent_session_id and are never touched — this is exactly the
  // precondition whose absence caused the same closure logic to be
  // reverted earlier the same day (2026-09-16); see
  // docs/roadmap/task-id-routing-spike.md.
  if (session.parent_session_id) {
    const parsedContent = (() => {
      try {
        return JSON.parse(msg.content) as { closesSession?: unknown };
      } catch {
        return {};
      }
    })();
    if (parsedContent.closesSession) {
      updateSession(session.id, { status: 'closed' });
      log.info('Closed task session after report_completion', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        parentSessionId: session.parent_session_id,
      });
    }
  }
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
