/**
 * Literal recent-turns tail for projected-lifecycle sessions. Read-only
 * host-side merge of `messages_in` + `messages_out` into plain text lines —
 * not the container's XML `<message>` format (a provider-facing convention
 * this never touches).
 *
 * Prefix-cache-aware anchored growth: a naive last-N sliding window shifts
 * its start point every turn, so the substituted text differs from byte
 * zero each time and Anthropic's longest-common-prefix cache matching gets
 * zero reuse across turns despite the calls being adjacent and mostly
 * identical. Instead the window's start point (the "anchor") is held fixed
 * across turns — each call is a strict superset of the previous call's tail
 * (append-only growth, N → N+1 → ... → 2N) — until the tail reaches 2×N,
 * at which point the anchor resets forward to the last N turns and the
 * cycle restarts. Validated as a real cost concern by a prior spike
 * (`docs/synthetic-context.md` in `~/Projects/nanoclaw`, "Planned:
 * prompt-cache-aware literal tail") — not a speculative addition.
 *
 * Compiler and responder run independent cycles with independent N
 * (`compileBriefing`'s COMPILER_TAIL_TURNS vs. `synthesize.ts`'s
 * RESPONDER_TAIL_TURNS) — anchor state per lane lives in `session_briefings`
 * (migration 025, this module's own table).
 *
 * The 2N turn-count trigger alone under-resets for a lane whose calls go
 * through Anthropic's server-side ephemeral prompt cache: a gap between
 * calls longer than the cache TTL already invalidates the cached prefix
 * regardless of where the anchor sits in its N→2N cycle, so the anchor keeps
 * growing through that gap and the eventual cache-miss rebuild pays full
 * price for a bigger tail than N ever required. The optional `cacheTtlMs`
 * param (migration 028's `*_last_call_at` columns) adds that second,
 * independent reset trigger for callers where it actually applies.
 *
 * Deliberately opt-in, not blanket-applied to every lane: the compiler lane
 * (`compileBriefing`) shells out to a fresh `claude -p --agent briefer`
 * process per call — a real Anthropic API call each time, so the ephemeral
 * cache TTL is a real constraint and this lane passes `cacheTtlMs`. The
 * responder lane (`synthesize.ts`, Lumen's own in-container session) instead
 * feeds a live provider session resume — a different caching path entirely,
 * not proven to share the same TTL behavior — so it omits `cacheTtlMs` and
 * keeps the original pure 2N-count reset until that's verified.
 */
import fs from 'fs';

import { inboundDbPath, outboundDbPath } from '../../session-manager.js';
import { openInboundDb, openOutboundDb } from '../../db/session-db.js';
import { getTailAnchor, setTailAnchor, type TailLane } from './db.js';

interface TailRow {
  timestamp: string;
  sender: string;
  text: string;
}

// Hard bound on how much history a single anchor-growth cycle will ever read
// or hold, independent of N — protects a long-lived agent-shared session from
// an unbounded per-turn read once growth is in play.
const SAFETY_CAP = 500;

// Anthropic's default ephemeral prompt-cache TTL, for callers that opt into
// the `cacheTtlMs` reset trigger. Not configurable per call today (would
// need a 1h-cache beta header to raise it) — if that changes, this constant
// is the one place to update.
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function parseText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

function readAllTurns(agentGroupId: string, sessionId: string): TailRow[] {
  const inPath = inboundDbPath(agentGroupId, sessionId);
  const outPath = outboundDbPath(agentGroupId, sessionId);

  const rows: TailRow[] = [];

  if (fs.existsSync(inPath)) {
    const db = openInboundDb(inPath);
    try {
      const inRows = db
        .prepare(
          `SELECT timestamp, content FROM messages_in WHERE kind IN ('chat','chat-sdk') ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(SAFETY_CAP) as Array<{ timestamp: string; content: string }>;
      for (const r of inRows) {
        let sender = 'user';
        try {
          const parsed = JSON.parse(r.content) as { sender?: string };
          sender = parsed.sender ?? 'user';
        } catch {
          // keep default
        }
        rows.push({ timestamp: r.timestamp, sender, text: parseText(r.content) });
      }
    } finally {
      db.close();
    }
  }

  if (fs.existsSync(outPath)) {
    const db = openOutboundDb(outPath);
    try {
      const outRows = db
        .prepare(`SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY timestamp DESC LIMIT ?`)
        .all(SAFETY_CAP) as Array<{ timestamp: string; content: string }>;
      for (const r of outRows) {
        rows.push({ timestamp: r.timestamp, sender: 'assistant', text: parseText(r.content) });
      }
    } finally {
      db.close();
    }
  }

  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return rows.slice(-SAFETY_CAP);
}

export function renderLiteralTail(
  agentGroupId: string,
  sessionId: string,
  sessionKey: string,
  lane: TailLane,
  n: number,
  leadingBriefing?: string,
  cacheTtlMs?: number,
): string {
  const all = readAllTurns(agentGroupId, sessionId);

  // The briefing (already formatted with its own per-entry headers by
  // getBriefingHistoryText) is prepended as an uncounted leading block — it
  // never touches `selected`, the anchor, or the N-turn budget below, so
  // growth and reset behavior are exactly as before regardless of length.
  const briefingBlock = leadingBriefing?.trim() ?? '';

  if (all.length === 0) return briefingBlock;

  const anchor = getTailAnchor(sessionKey, lane);

  const cacheStale =
    cacheTtlMs !== undefined && anchor.lastCallAt !== null && Date.now() - Date.parse(anchor.lastCallAt) > cacheTtlMs;

  let selected: TailRow[];
  const needsReset = anchor.anchorTs === null || anchor.count >= 2 * n || cacheStale;

  selected = needsReset ? [] : all.filter((r) => r.timestamp >= anchor.anchorTs!);

  // Anchor missing, past its 2N cap, cache-stale (see CACHE_TTL_MS above), or
  // aged out of SAFETY_CAP (filter came back empty) — reset to the last N
  // turns, fresh cycle.
  if (selected.length === 0) {
    selected = all.slice(-n);
  }

  const newAnchorTs = selected[0]?.timestamp ?? null;
  setTailAnchor(sessionKey, lane, newAnchorTs, selected.length);

  const turnsBlock = selected.map((r) => `[${r.timestamp}] ${r.sender}: ${r.text}`).join('\n');

  return briefingBlock ? `${briefingBlock}\n\n${turnsBlock}` : turnsBlock;
}
