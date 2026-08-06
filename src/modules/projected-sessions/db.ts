/**
 * DB access for the projected-sessions module. Owns two tables entirely
 * (migration 025) — no reach-in to `container_configs` or any core table.
 */
import { getDb } from '../../db/connection.js';
import { inboundDbPath } from '../../session-manager.js';
import { openInboundDb } from '../../db/session-db.js';
import { combineTextAndAttachments, toQuoteBlock } from './literal-tail.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { formatLocalIsoOffset } from '../../timezone.js';
import fs from 'fs';

export function isEnabled(agentGroupId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM projected_sessions_enabled WHERE agent_group_id = ?').get(agentGroupId);
  return row !== undefined;
}

export function setEnabled(agentGroupId: string, enabled: boolean): void {
  if (enabled) {
    getDb()
      .prepare(
        `INSERT INTO projected_sessions_enabled (agent_group_id, enabled_at) VALUES (?, ?)
         ON CONFLICT(agent_group_id) DO NOTHING`,
      )
      .run(agentGroupId, new Date().toISOString());
  } else {
    getDb().prepare('DELETE FROM projected_sessions_enabled WHERE agent_group_id = ?').run(agentGroupId);
  }
}

export function listEnabled(): string[] {
  return (
    getDb().prepare('SELECT agent_group_id FROM projected_sessions_enabled').all() as Array<{
      agent_group_id: string;
    }>
  ).map((r) => r.agent_group_id);
}

export function getSessionBriefing(sessionKey: string): string {
  const row = getDb().prepare('SELECT content FROM session_briefings WHERE session_key = ?').get(sessionKey) as
    | { content: string }
    | undefined;
  return row?.content ?? '';
}

export function setSessionBriefing(sessionKey: string, content: string): void {
  getDb()
    .prepare(
      `INSERT INTO session_briefings (session_key, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
    .run(sessionKey, content, new Date().toISOString());
}

/**
 * Rolling briefing history, capped at `cap` most recent entries per session
 * key — shown to both compiler and responder tails so a briefing ages out
 * of context at the same rate for both sides (see migration 027). Trims on
 * every insert rather than on read, so the table never grows past `cap`
 * rows per session key.
 */
export function appendBriefingHistory(sessionKey: string, content: string, cap: number): void {
  const db = getDb();
  const nextSeq = (
    db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM session_briefing_history WHERE session_key = ?')
      .get(sessionKey) as { next: number }
  ).next;
  db.prepare('INSERT INTO session_briefing_history (session_key, seq, content, created_at) VALUES (?, ?, ?, ?)').run(
    sessionKey,
    nextSeq,
    content,
    new Date().toISOString(),
  );
  db.prepare(
    `DELETE FROM session_briefing_history WHERE session_key = ? AND seq <= (
       SELECT seq FROM session_briefing_history WHERE session_key = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
     )`,
  ).run(sessionKey, sessionKey, cap);
}

export interface BriefingHistoryEntry {
  content: string;
  createdAt: string;
}

/**
 * Oldest-first, the last `cap` briefings for this session key — structured
 * (not pre-rendered to text) so the caller can interleave each entry by its
 * own `createdAt` against the raw turns in `renderLiteralTail` rather than
 * clumping all past briefings into one leading block. A briefing summarizes
 * turns that came before it and was itself superseded by turns that came
 * after — showing it out of that order reads as the compiler/responder
 * "jumping around" in time instead of following a single timeline.
 */
export function getBriefingHistoryEntries(sessionKey: string, cap: number): BriefingHistoryEntry[] {
  const rows = getDb()
    .prepare('SELECT content, created_at FROM session_briefing_history WHERE session_key = ? ORDER BY seq DESC LIMIT ?')
    .all(sessionKey, cap) as Array<{ content: string; created_at: string }>;
  return rows.reverse().map((r) => ({ content: r.content, createdAt: r.created_at }));
}

export type TailLane = 'compiler' | 'responder';

export interface TailAnchor {
  anchorTs: string | null;
  count: number;
  lastCallAt: string | null;
}

export function getTailAnchor(sessionKey: string, lane: TailLane): TailAnchor {
  const col = lane === 'compiler' ? 'compiler_anchor_ts' : 'responder_anchor_ts';
  const countCol = lane === 'compiler' ? 'compiler_anchor_count' : 'responder_anchor_count';
  const lastCallCol = lane === 'compiler' ? 'compiler_last_call_at' : 'responder_last_call_at';
  const row = getDb()
    .prepare(
      `SELECT ${col} AS anchorTs, ${countCol} AS count, ${lastCallCol} AS lastCallAt
       FROM session_briefings WHERE session_key = ?`,
    )
    .get(sessionKey) as { anchorTs: string | null; count: number; lastCallAt: string | null } | undefined;
  return row ?? { anchorTs: null, count: 0, lastCallAt: null };
}

/** `lastCallAt` is stamped with the current wall-clock time on every call — it
 * marks when the cache-relevant API call happened, not a message timestamp,
 * so it can be compared against the cache TTL regardless of message cadence. */
export function setTailAnchor(sessionKey: string, lane: TailLane, anchorTs: string | null, count: number): void {
  const col = lane === 'compiler' ? 'compiler_anchor_ts' : 'responder_anchor_ts';
  const countCol = lane === 'compiler' ? 'compiler_anchor_count' : 'responder_anchor_count';
  const lastCallCol = lane === 'compiler' ? 'compiler_last_call_at' : 'responder_last_call_at';
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO session_briefings (session_key, content, updated_at, ${col}, ${countCol}, ${lastCallCol})
       VALUES (?, '', ?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET ${col} = excluded.${col}, ${countCol} = excluded.${countCol}, ${lastCallCol} = excluded.${lastCallCol}`,
    )
    .run(sessionKey, now, anchorTs, count, now);
}

const BATCH_READ_CAP = 50;

/**
 * Plain-text rendering of the currently-pending inbound batch for a session
 * — read directly from `inbound.db` rather than being threaded through from
 * `router.ts`. This is what lets the whole per-wake hook live in
 * `container-runner.ts`'s `spawnContainer` (mirroring the existing
 * `agent_destinations` hasTable-gated hook) instead of `router.ts`: by the
 * time `spawnContainer` runs, `writeSessionMessage` has already persisted
 * the batch, so there's nothing router-side left to pass in.
 */
export function readPendingBatchText(agentGroupId: string, sessionId: string): string {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return '';

  const db = openInboundDb(dbPath);
  try {
    // kind list includes 'task' so a due reminder still gives the briefer
    // something to work with — otherwise a task wake looks identical to a
    // bare respawn (empty batch) and the briefer is skipped even though the
    // agent is about to act on real content. 'system' deliberately excluded:
    // it's the host-shim/caption request-response transport, consumed
    // directly by a dedicated polling CLI process via raw content match (see
    // container/agent-runner/src/cli/host-shim.ts) — never acked through the
    // normal claim/processing_ack pipeline, so an orphaned row (issuing CLI
    // process died before the response landed) stays 'pending' forever and
    // would otherwise resurface as a "new" message on every future compile,
    // no matter how old. Same filter the live agent's own poll-loop already
    // applies (see attachment-caption/notify.ts's doc comment).
    const rows = db
      .prepare(
        `SELECT kind, content, timestamp FROM messages_in WHERE status IN ('pending', 'staged') AND kind IN ('chat','chat-sdk','task','webhook')
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(BATCH_READ_CAP) as Array<{ kind: string; content: string; timestamp: string }>;

    // Same "[local-time+offset] Sender: text" shape renderLiteralTail uses
    // for "Recent turns" — the briefer was reading an unattributed, undated
    // blob here otherwise, one format inconsistency away from misreading
    // who said what or mistiming a claim it later cites.
    const tz = resolveGroupTimezone(agentGroupId);
    return rows
      .map((r) => {
        const stamp = formatLocalIsoOffset(r.timestamp, tz);
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parsed = JSON.parse(r.content) as {
            text?: string;
            attachments?: any[];
            prompt?: string;
            sender?: string;
            source?: string;
            payload?: unknown;
          };
          if (r.kind === 'task') return `[${stamp}] Scheduled task: ${parsed.prompt ?? r.content}`;
          if (r.kind === 'webhook') {
            return `[${stamp}] Webhook (${parsed.source ?? 'unknown'}): ${JSON.stringify(parsed.payload ?? parsed)}`;
          }
          // A caption and any user-supplied text are both kept — text alone
          // says nothing about what's in the image, and dropping it in favor
          // of the placeholder loses what the user actually said. This is a
          // read-only render (no lazy caption/persist here); renderLiteralTail's
          // own pass over the same row, called moments later by
          // compileBriefing, does the lazy captioning.
          const text = combineTextAndAttachments(parsed.text, parsed.attachments) ?? r.content;
          return `[${stamp}] ${parsed.sender ?? 'user'}: ${text}`;
        } catch {
          return `[${stamp}] ${r.content}`;
        }
      })
      .map(toQuoteBlock)
      .join('\n\n');
  } finally {
    db.close();
  }
}
