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
 * spawnContainer (reads the pending batch straight from inbound.db, same
 * pattern as projected-sessions' synthesize.ts); outbound turns are
 * appended from delivery.ts, right after a message is marked delivered.
 *
 * Known limitation: if a container crashes mid-turn and host-sweep resets
 * a message back to 'pending' for a retry wake, that message's inbound
 * turn gets appended again on the retry — a rare duplicate line in the
 * transcript. Not tracked/deduped (would need a new table, defeating the
 * zero-footprint design) — same "human can fix the vault file by hand"
 * tolerance as an unresolved sender name.
 */
import fs from 'fs';

import { execHostShim } from '../host-shim/exec.js';
import { inboundDbPath } from '../../session-manager.js';
import { openInboundDb } from '../../db/session-db.js';
import { log } from '../../log.js';

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

/** Append every currently-pending inbound chat turn for this session. Called at wake, before the container consumes them. */
export async function appendPendingInboundTurns(agentGroupId: string, sessionId: string): Promise<void> {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const db = openInboundDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT timestamp, content FROM messages_in WHERE status = 'pending' AND kind IN ('chat','chat-sdk') ORDER BY seq ASC`,
      )
      .all() as Array<{ timestamp: string; content: string }>;
    for (const row of rows) {
      const { sender, text } = parseChatContent(row.content);
      await appendTranscriptTurn(agentGroupId, sender, row.timestamp, text);
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
