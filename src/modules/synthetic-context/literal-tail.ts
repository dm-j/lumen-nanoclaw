/**
 * Literal recent-turns tail for `session_lifecycle = 'projected'` sessions
 * (Implementation Plan §4c). Read-only host-side merge of `messages_in` +
 * `messages_out` into plain text lines — not the container's XML `<message>`
 * format (that's a provider-facing convention this never touches).
 *
 * Prefix-cache-aware anchored growth: a naive last-N sliding window shifts
 * its start point every turn, so the substituted text differs from byte
 * zero each time and Anthropic's longest-common-prefix cache matching gets
 * zero reuse across turns despite the calls being adjacent and mostly
 * identical. Instead the window's start point (the "anchor") is held fixed
 * across turns — each call is a strict superset of the previous call's tail
 * (append-only growth, N → N+1 → ... → 2N) — until the tail reaches 2×N,
 * at which point the anchor resets forward to the last N turns and the
 * cycle restarts. This was validated as a real cost concern in the prior
 * synthetic-context spike (`docs/synthetic-context.md` in `~/Projects/nanoclaw`,
 * "Planned: prompt-cache-aware literal tail") — not a speculative addition.
 *
 * Compiler and responder run independent cycles with independent N
 * (`compileBriefing`'s COMPILER_TAIL_TURNS vs. `router.ts`'s
 * RESPONDER_TAIL_TURNS) — anchor state per lane lives in `session_briefings`
 * (migration 024).
 */
import fs from 'fs';

import { inboundDbPath, outboundDbPath } from '../../session-manager.js';
import { openInboundDb, openOutboundDb } from '../../db/session-db.js';
import { getTailAnchor, setTailAnchor, type TailLane } from '../../db/session-briefings.js';

interface TailRow {
  timestamp: string;
  sender: string;
  text: string;
}

// Hard bound on how much history a single anchor-growth cycle will ever read
// or hold, independent of N — protects a long-lived agent-shared session from
// an unbounded per-turn read once growth is in play. 2N never exceeds this
// for any N used today (compiler=6, responder=40); revisit if N grows.
const SAFETY_CAP = 500;

function parseText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

/** All chat turns for a session, oldest first, capped at SAFETY_CAP most recent. */
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

/**
 * Render this lane's literal tail for a session, growing the anchored window
 * or resetting it as needed, and persisting the new anchor state.
 */
export function renderLiteralTail(
  agentGroupId: string,
  sessionId: string,
  sessionKey: string,
  lane: TailLane,
  n: number,
): string {
  const all = readAllTurns(agentGroupId, sessionId);
  if (all.length === 0) return '';

  const anchor = getTailAnchor(sessionKey, lane);

  let selected: TailRow[];
  const needsReset = anchor.anchorTs === null || anchor.count >= 2 * n;

  if (!needsReset) {
    selected = all.filter((r) => r.timestamp >= anchor.anchorTs!);
  } else {
    selected = [];
  }

  // Anchor missing, past its 2N cap, or stale (the anchored row aged out of
  // the SAFETY_CAP window and the filter came back empty) — reset to the
  // last N turns and start a fresh growth cycle.
  if (selected.length === 0) {
    selected = all.slice(-n);
  }

  const newAnchorTs = selected[0]?.timestamp ?? null;
  setTailAnchor(sessionKey, lane, newAnchorTs, selected.length);

  return selected.map((r) => `[${r.timestamp}] ${r.sender}: ${r.text}`).join('\n');
}
