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
): string {
  const all = readAllTurns(agentGroupId, sessionId);

  // The briefing (already formatted with its own per-entry headers by
  // getBriefingHistoryText) is prepended as an uncounted leading block — it
  // never touches `selected`, the anchor, or the N-turn budget below, so
  // growth and reset behavior are exactly as before regardless of length.
  const briefingBlock = leadingBriefing?.trim() ?? '';

  if (all.length === 0) return briefingBlock;

  const anchor = getTailAnchor(sessionKey, lane);

  let selected: TailRow[];
  const needsReset = anchor.anchorTs === null || anchor.count >= 2 * n;

  selected = needsReset ? [] : all.filter((r) => r.timestamp >= anchor.anchorTs!);

  // Anchor missing, past its 2N cap, or stale (aged out of SAFETY_CAP,
  // filter came back empty) — reset to the last N turns, fresh cycle.
  if (selected.length === 0) {
    selected = all.slice(-n);
  }

  const newAnchorTs = selected[0]?.timestamp ?? null;
  setTailAnchor(sessionKey, lane, newAnchorTs, selected.length);

  const turnsBlock = selected.map((r) => `[${r.timestamp}] ${r.sender}: ${r.text}`).join('\n');

  return briefingBlock ? `${briefingBlock}\n\n${turnsBlock}` : turnsBlock;
}
