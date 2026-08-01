/**
 * `session_briefings` — host-side rolling briefing per projected-lifecycle
 * session key. See migration 023 and Implementation Plan §2.
 */
import { getDb } from './connection.js';

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

export type TailLane = 'compiler' | 'responder';

export interface TailAnchor {
  anchorTs: string | null;
  count: number;
}

/**
 * Prefix-cache-aware literal-tail anchor state (Implementation Plan §4c).
 * See migration 024 for the growth/reset semantics.
 */
export function getTailAnchor(sessionKey: string, lane: TailLane): TailAnchor {
  const col = lane === 'compiler' ? 'compiler_anchor_ts' : 'responder_anchor_ts';
  const countCol = lane === 'compiler' ? 'compiler_anchor_count' : 'responder_anchor_count';
  const row = getDb()
    .prepare(`SELECT ${col} AS anchorTs, ${countCol} AS count FROM session_briefings WHERE session_key = ?`)
    .get(sessionKey) as { anchorTs: string | null; count: number } | undefined;
  return row ?? { anchorTs: null, count: 0 };
}

export function setTailAnchor(sessionKey: string, lane: TailLane, anchorTs: string | null, count: number): void {
  const col = lane === 'compiler' ? 'compiler_anchor_ts' : 'responder_anchor_ts';
  const countCol = lane === 'compiler' ? 'compiler_anchor_count' : 'responder_anchor_count';
  getDb()
    .prepare(
      `INSERT INTO session_briefings (session_key, content, updated_at, ${col}, ${countCol})
       VALUES (?, '', ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET ${col} = excluded.${col}, ${countCol} = excluded.${countCol}`,
    )
    .run(sessionKey, new Date().toISOString(), anchorTs, count);
}
