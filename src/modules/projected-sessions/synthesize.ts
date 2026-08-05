/**
 * Per-wake hook: called from `container-runner.ts`'s `spawnContainer`,
 * gated on `hasTable(getDb(), 'projected_sessions_enabled')` — same shape
 * as the existing `agent_destinations` hook that projects destinations into
 * a session on every wake. Nothing runs (import isn't even reached) unless
 * this module's table exists.
 *
 * Reads the currently-pending inbound batch straight from `inbound.db`
 * (`readPendingBatchText`) rather than being threaded an event object from
 * `router.ts` — by the time `spawnContainer` runs, `writeSessionMessage` has
 * already persisted the batch, so there's nothing left for a router-level
 * hook to add. This is what keeps `router.ts` untouched entirely.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { sessionDir } from '../../session-manager.js';
import { log } from '../../log.js';
import { getBriefingHistoryText, isEnabled, readPendingBatchText } from './db.js';
import { COMPILER_TAIL_TURNS, compileBriefing, sessionBriefingKey } from './compile-briefing.js';
import { renderLiteralTail } from './literal-tail.js';

// Responder's own tail is real working context, not just tone.
const RESPONDER_TAIL_TURNS = 15;

// Briefing history shown to the responder is capped at the same size as the
// briefer's own (COMPILER_TAIL_TURNS) — a briefing ages out of context at
// the same rate for both sides, so changing information doesn't linger
// longer for Lumen than it does for the briefer that produced it.
const RESPONDER_BRIEFING_CAP = COMPILER_TAIL_TURNS;

/** Marker file inside the group's already-RW-mounted folder (`/workspace/agent`
 *  in the container) — the container-side hook reads this directly, no
 *  `container.json`/`RunnerConfig` field needed. */
function markerPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, '.projected-sessions-enabled');
}

export async function maybeSynthesizeProjectedContext(agentGroupId: string, sessionId: string): Promise<void> {
  const group = getAgentGroup(agentGroupId);
  if (!group) return;
  const marker = markerPath(group.folder);

  if (!isEnabled(agentGroupId)) {
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
    return;
  }
  fs.writeFileSync(marker, '');

  const session = getSession(sessionId);
  if (!session) return;

  try {
    const sessionKey = sessionBriefingKey(agentGroupId, session.messaging_group_id, session.thread_id);
    const batchText = readPendingBatchText(agentGroupId, sessionId);
    const briefing = await compileBriefing(agentGroupId, sessionId, sessionKey, batchText);
    // Up to RESPONDER_BRIEFING_CAP past briefings (oldest-first, includes
    // the one just compiled above), folded into the tail as an uncounted
    // leading block — still written to briefing.md too (just the latest),
    // so anything reading that file directly is unaffected.
    const briefingHistory = getBriefingHistoryText(sessionKey, RESPONDER_BRIEFING_CAP);
    const tail = await renderLiteralTail(
      agentGroupId,
      sessionId,
      sessionKey,
      'responder',
      RESPONDER_TAIL_TURNS,
      briefingHistory,
    );
    const dir = sessionDir(agentGroupId, sessionId);
    fs.writeFileSync(path.join(dir, 'briefing.md'), briefing);
    fs.writeFileSync(path.join(dir, 'recent-turns.md'), tail);
  } catch (err) {
    // Never block a wake on this — same fail-closed stance as
    // compile-briefing's own internal try/catch (this one covers everything
    // else: readPendingBatchText, renderLiteralTail, the fs writes).
    log.warn('maybeSynthesizeProjectedContext threw — wake proceeds without a fresh briefing', {
      agentGroupId,
      sessionId,
      err,
    });
  }
}
