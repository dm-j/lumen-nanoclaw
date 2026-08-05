/**
 * Fires off the actual (slow, networked) image-captioning call after a
 * message has already been written and delivered — captioning must never
 * block message delivery, only follow it.
 *
 * The attachment's `captionId` (stamped synchronously and instantly by
 * `stampCaptionIds` before the message was written — see caption.ts) is
 * what lets the placeholder the agent already saw ("processing, id: X") be
 * matched up with this job's result later.
 *
 * On completion, the result is both persisted onto the original message row
 * (so later tail/vault renders pick it up without recapturing it) and
 * delivered as a fresh `chat`-kind message so the live agent actually sees
 * it. Deliberately NOT `kind: 'system'` — the agent-runner poll loop
 * (container/agent-runner/src/poll-loop.ts, both the main batch fetch and
 * the mid-query follow-up push) unconditionally filters out `system`-kind
 * rows as "MCP tool responses" consumed elsewhere (e.g. the interactive
 * ask_user_question flow's own dedicated wait). A `system` row here would
 * be written, wake the container, and then be silently invisible to every
 * prompt-building path forever — not deferred to the next message, just
 * never seen. `chat` flows through both paths: picked up on the container's
 * next poll if it's idle, or pushed into the *active* query mid-stream
 * (poll-loop's "Pushing N follow-up message(s) into active query") if it's
 * still generating a reply to the original message.
 *
 * Retries distinguish contention from real failure. Ollama's local daemon is
 * shared with the agent's own conversation model — a long agent turn can
 * starve a concurrent captioning call, which manifests as our own
 * captionImage AbortController firing at TIMEOUT_MS ("This operation was
 * aborted"), observed in practice racing a 46s /v1/messages call on the same
 * daemon. That's a "try again once the daemon's free" situation, not a
 * broken model — it gets a generous retry budget with backoff. Anything else
 * (a fast 500, an empty response, a genuine network refusal) is a real
 * failure and gets a stricter budget. Either way, nothing is written to the
 * agent's session until the retry loop actually concludes — no per-attempt
 * noise, just the final outcome.
 */
import fs from 'fs';
import path from 'path';

import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { openInboundDb, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { appendCaptionedAttachment } from '../vault-transcript/index.js';
import { log } from '../../log.js';
import { captionImage, isContentionError, isImageAttachment, type CaptionResult } from './caption.js';

interface ImageAttachment {
  captionId?: string;
  localPath?: string;
  caption?: string;
  captionError?: string;
  name?: string;
  [key: string]: unknown;
}

// Contention: generous — the daemon is busy, not broken, and will free up.
// Failure: strict — a real error (bad response, network refusal) is far less
// likely to self-resolve on retry, so don't hammer it.
const CONTENTION_MAX_ATTEMPTS = 5;
const FAILURE_MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempts captionImage until it succeeds or its retry budget (contention vs. failure, classified per attempt) is exhausted. Backs off between attempts — never busy-loops the daemon. */
async function captionWithRetry(bytes: Buffer, userCaption: string | undefined): Promise<CaptionResult> {
  let attempt = 0;
  let result: CaptionResult;
  while (true) {
    attempt++;
    result = await captionImage(bytes.toString('base64'), userCaption);
    if (result.ok) return result;

    const maxAttempts = isContentionError(result.text) ? CONTENTION_MAX_ATTEMPTS : FAILURE_MAX_ATTEMPTS;
    if (attempt >= maxAttempts) return result;

    await sleep(Math.min(BACKOFF_BASE_MS * attempt, BACKOFF_CAP_MS));
  }
}

/** Fire-and-forget: never awaited by the caller, never throws out of it. */
export function triggerCaptioning(agentGroupId: string, sessionId: string, messageId: string): void {
  void runCaptioning(agentGroupId, sessionId, messageId).catch((err) => {
    log.warn('Background captioning job failed', { agentGroupId, sessionId, messageId, err });
  });
}

async function runCaptioning(agentGroupId: string, sessionId: string, messageId: string): Promise<void> {
  const row = readMessage(agentGroupId, sessionId, messageId);
  if (!row?.attachments) return;
  const { attachments, sender, timestamp, platformId, channelType, threadId, text } = row;

  for (const att of attachments) {
    if (att.caption || typeof att.captionId !== 'string' || typeof att.localPath !== 'string') continue;
    if (!isImageAttachment(att as Record<string, unknown>)) continue;

    let result: CaptionResult;
    try {
      const bytes = fs.readFileSync(path.join(sessionDir(agentGroupId, sessionId), att.localPath));
      result = await captionWithRetry(bytes, text || undefined);
    } catch (err) {
      result = { ok: false, text: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      att.caption = result.text;
      delete att.captionError;
    } else {
      att.captionError = result.text;
    }

    persistAttachments(agentGroupId, sessionId, messageId, attachments);

    const notice = result.ok
      ? `Image "${att.name}" (id: ${att.captionId}) has been described:\n\n${result.text}`
      : `Image "${att.name}" (id: ${att.captionId}) could not be described: ${result.text}`;
    writeSessionMessage(agentGroupId, sessionId, {
      id: `caption-${att.captionId}-${Date.now()}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId,
      channelType,
      threadId,
      content: JSON.stringify({ sender: 'System', text: notice }),
    });

    // The retry loop has just concluded (success or exhausted) — this is the
    // reliable point to get the result into the vault transcript (the
    // synchronous export at wake time, vault-transcript/index.ts's
    // appendPendingInboundTurns, ran before this job even started and had
    // nothing to record yet). Recorded either way, always tagged with
    // captionId, so a terminal failure is still traceable in the vault, not
    // just silently dropped.
    await appendCaptionedAttachment(agentGroupId, sessionId, sender, timestamp, att.localPath, att.captionId, result);

    const session = getSession(sessionId);
    if (session) await wakeContainer(session);
  }
}

function readMessage(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
): {
  attachments: ImageAttachment[] | null;
  sender: string;
  timestamp: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  text: string | undefined;
} | null {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    const row = db
      .prepare('SELECT content, timestamp, platform_id, channel_type, thread_id FROM messages_in WHERE id = ?')
      .get(messageId) as
      | {
          content: string;
          timestamp: string;
          platform_id: string | null;
          channel_type: string | null;
          thread_id: string | null;
        }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.content) as {
      attachments?: ImageAttachment[];
      sender?: string;
      author?: { fullName?: string; userName?: string };
      text?: string;
    };
    return {
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : null,
      sender: parsed.sender || parsed.author?.fullName || parsed.author?.userName || 'Unknown',
      timestamp: row.timestamp,
      platformId: row.platform_id,
      channelType: row.channel_type,
      threadId: row.thread_id,
      text: typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text : undefined,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function persistAttachments(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  attachments: ImageAttachment[],
): void {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(messageId) as
      | { content: string }
      | undefined;
    if (!row) return;
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    parsed.attachments = attachments;
    db.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(parsed), messageId);
  } catch (err) {
    log.warn('Failed to persist attachment caption', { agentGroupId, sessionId, messageId, err });
  } finally {
    db.close();
  }
}
