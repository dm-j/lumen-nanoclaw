/**
 * Live per-turn vault transcript export.
 *
 * No table, no enable/disable flag, no module registration — this relies
 * entirely on execHostShim's existing behavior of resolving a whitelisted
 * `<name>-host` script per agent group (add-host-scripts) and cleanly
 * no-op'ing when one doesn't exist. A group with no `transcript-append-host`
 * script pays only a cheap whitelist-folder stat per turn, never a process
 * spawn — so this is safe to call unconditionally for every agent group,
 * not gated behind hasTable() the way schema-owning modules are.
 *
 * Two call sites: inbound turns are appended from container-runner.ts's
 * wakeContainer, before the already-running short-circuit (reads the
 * pending batch straight from inbound.db, same pattern as
 * projected-sessions' synthesize.ts) — this must run on every wake, not
 * just fresh spawns, since an already-warm container's poll loop picks up
 * new inbound rows with no other host-side hook; outbound turns are
 * appended from delivery.ts, right after a message is marked delivered.
 *
 * Known limitation: if a container crashes mid-turn and host-sweep resets
 * a message back to 'pending' for a retry wake, that message's inbound
 * turn gets appended again on the retry — a rare duplicate line in the
 * transcript. Not tracked/deduped in the DB (would need a new table,
 * defeating the zero-footprint design) — same "human can fix the vault
 * file by hand" tolerance as an unresolved sender name. An in-memory-only
 * watermark (`lastExportedSeq` below) still covers the much more common
 * case — wakeContainer firing more than once for the same session while a
 * message is still 'pending' (e.g. two messages close together on an
 * already-warm container) — without persisting anything; it resets on
 * host restart, which only re-widens the window back to the rare case
 * above, never worse.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { execHostShim } from '../host-shim/exec.js';
import { inboundDbPath, sessionDir } from '../../session-manager.js';
import { openInboundDb } from '../../db/session-db.js';
import { isImageAttachment, resizeToBuffer } from '../attachment-caption/caption.js';
import { combineTextAndAttachments } from '../projected-sessions/literal-tail.js';
import { log } from '../../log.js';

const lastExportedSeq = new Map<string, number>();

async function appendTranscriptTurn(
  agentGroupId: string,
  speaker: string,
  timestampIso: string,
  text: string,
  imagePath?: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const args = [speaker, timestampIso, trimmed];
    if (imagePath) args.push(imagePath);
    const result = await execHostShim(agentGroupId, 'transcript-append', args);
    if (!result.ok && result.refusalReason?.startsWith('no whitelisted shim named')) return; // expected — script absent
    if (!result.ok || result.exitCode !== 0) {
      log.warn('transcript-append failed', {
        agentGroupId,
        exitCode: result.exitCode,
        refusalReason: result.refusalReason,
        stderr: result.stderr?.slice(0, 300),
      });
    }
  } catch (err) {
    log.warn('transcript-append threw', { agentGroupId, err });
  }
}

function parseChatContent(content: string): { sender: string; text: string } {
  try {
    const parsed = JSON.parse(content) as {
      sender?: string;
      author?: { fullName?: string; userName?: string };
      text?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attachments?: any[];
    };
    const sender = parsed.sender || parsed.author?.fullName || parsed.author?.userName || 'Unknown';
    // A user-supplied caption and the attachment placeholder are both kept —
    // same reasoning as literal-tail.ts's combineTextAndAttachments: text
    // alone says nothing about what's in the image, and dropping it in
    // favor of the placeholder loses what the user actually said.
    return { sender, text: combineTextAndAttachments(parsed.text, parsed.attachments) ?? content };
  } catch {
    return { sender: 'Unknown', text: content };
  }
}

/** Resize a staged attachment's bytes to a throwaway temp file for transcript-append-host to copy into the vault. Caller deletes it after the call. */
async function stageResizedImage(agentGroupId: string, sessionId: string, localPath: string): Promise<string | null> {
  try {
    const filePath = path.join(sessionDir(agentGroupId, sessionId), localPath);
    const bytes = fs.readFileSync(filePath);
    const resized = await resizeToBuffer(bytes);
    const tempPath = path.join(
      os.tmpdir(),
      `nanoclaw-vault-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
    );
    fs.writeFileSync(tempPath, resized);
    return tempPath;
  } catch (err) {
    log.warn('Failed to stage vault image attachment', { agentGroupId, sessionId, localPath, err });
    return null;
  }
}

/**
 * If the row's content has exactly one caption-gated image attachment
 * (captioned successfully, staged to disk) *already*, resize it to a temp
 * file for transcript-append-host to copy into the vault. Caption-gated
 * only — a captionError'd image isn't copied; the transcript line already
 * carries the failure text. Returns null when there's nothing to attach.
 *
 * In the common case this misses: captioning now runs asynchronously,
 * kicked off from message delivery (attachment-caption/notify.ts) — well
 * after this function's caller (appendPendingInboundTurns) has already run
 * at wake time, before a container even starts. This synchronous path only
 * catches the rare case a caption already landed by wake time (e.g. a lazy
 * recapture from a previous render). The reliable path is
 * `appendCaptionedAttachment` below, called once notify.ts's job actually
 * has a result.
 */
async function stageVaultImage(agentGroupId: string, sessionId: string, content: string): Promise<string | null> {
  let parsed: { attachments?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const attachments = parsed.attachments;
  if (!Array.isArray(attachments)) return null;

  const att = attachments.find(
    (a) => typeof a.caption === 'string' && a.caption && typeof a.localPath === 'string' && isImageAttachment(a),
  );
  if (!att) return null;

  return stageResizedImage(agentGroupId, sessionId, att.localPath as string);
}

/**
 * Appends a vault transcript line for an image once captioning has actually
 * concluded — success or exhausted-retries failure alike (called from
 * attachment-caption/notify.ts's runCaptioning after its retry loop
 * settles). The line always references the attachment's `captionId`, so a
 * later reader (human or agent) can correlate a transcript entry back to the
 * exact attachment even across a captionless run, a retry, or a resend under
 * a different message id. The resized image itself is attached via
 * transcript-append-host's optional image-path arg whenever staging
 * succeeds — including on a captioning failure, since the bytes are already
 * on disk regardless of whether a description was produced. No-op if the
 * group has no transcript-append-host script (execHostShim's usual no-op).
 */
export async function appendCaptionedAttachment(
  agentGroupId: string,
  sessionId: string,
  sender: string,
  timestampIso: string,
  localPath: string,
  captionId: string,
  result: { ok: boolean; text: string },
): Promise<void> {
  const line = result.ok
    ? `[image id: ${captionId}] ${result.text}`
    : `[image id: ${captionId}] could not be described: ${result.text}`;
  const imagePath = await stageResizedImage(agentGroupId, sessionId, localPath);
  try {
    await appendTranscriptTurn(agentGroupId, sender, timestampIso, line, imagePath ?? undefined);
  } finally {
    if (imagePath) fs.rmSync(imagePath, { force: true });
  }
}

/** Append every currently-pending inbound chat turn for this session not already exported. Called at wake, before the container consumes them. */
export async function appendPendingInboundTurns(agentGroupId: string, sessionId: string): Promise<void> {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const db = openInboundDb(dbPath);
  try {
    const sinceSeq = lastExportedSeq.get(sessionId) ?? 0;
    const rows = db
      .prepare(
        `SELECT id, seq, timestamp, content FROM messages_in
         WHERE status = 'pending' AND kind IN ('chat','chat-sdk') AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(sinceSeq) as Array<{ id: string; seq: number; timestamp: string; content: string }>;
    for (const row of rows) {
      // The captioning job's own completion notice (attachment-caption/notify.ts,
      // id prefix 'caption-') is a synthetic chat-kind row so the agent-runner
      // poll loop actually delivers it — but it already gets its own vault line
      // (with the image attached) via appendCaptionedAttachment below, called
      // right when the caption lands. Exporting it here too would double up
      // the same description as a second, image-less line.
      if (row.id.startsWith('caption-')) {
        lastExportedSeq.set(sessionId, row.seq);
        continue;
      }
      const { sender, text } = parseChatContent(row.content);
      const imagePath = await stageVaultImage(agentGroupId, sessionId, row.content);
      try {
        await appendTranscriptTurn(agentGroupId, sender, row.timestamp, text, imagePath ?? undefined);
      } finally {
        if (imagePath) fs.rmSync(imagePath, { force: true });
      }
      lastExportedSeq.set(sessionId, row.seq);
    }
  } finally {
    db.close();
  }
}

/** Append one delivered outbound chat turn. Called from delivery.ts right after markDelivered. */
export async function appendDeliveredOutboundTurn(
  agentGroupId: string,
  assistantName: string,
  timestampIso: string,
  content: string,
): Promise<void> {
  const { text } = parseChatContent(content);
  await appendTranscriptTurn(agentGroupId, assistantName, timestampIso, text);
}
