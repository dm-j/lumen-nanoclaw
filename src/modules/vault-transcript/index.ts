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

import { execHostShim } from '../host-shim/exec.js';
import { inboundDbPath } from '../../session-manager.js';
import { openInboundDb } from '../../db/session-db.js';
import { log } from '../../log.js';

const lastExportedSeq = new Map<string, number>();

async function appendTranscriptTurn(
  agentGroupId: string,
  speaker: string,
  timestampIso: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const result = await execHostShim(agentGroupId, 'transcript-append', [speaker, timestampIso, trimmed]);
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
    };
    return {
      sender: parsed.sender || parsed.author?.fullName || parsed.author?.userName || 'Unknown',
      text: parsed.text ?? content,
    };
  } catch {
    return { sender: 'Unknown', text: content };
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
        `SELECT seq, timestamp, content FROM messages_in
         WHERE status = 'pending' AND kind IN ('chat','chat-sdk') AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(sinceSeq) as Array<{ seq: number; timestamp: string; content: string }>;
    for (const row of rows) {
      const { sender, text } = parseChatContent(row.content);
      await appendTranscriptTurn(agentGroupId, sender, row.timestamp, text);
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
