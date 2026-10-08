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
import { getContainerConfig } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { sessionDir } from '../../session-manager.js';
import { log } from '../../log.js';
import { getBriefingHistoryEntries, getSessionBriefing, isEnabled, readPendingBatchText } from './db.js';
import { compileBriefing, sessionBriefingKey } from './compile-briefing.js';
import { renderLiteralTail } from './literal-tail.js';

// Responder's own tail is real working context, not just tone.
const RESPONDER_TAIL_TURNS = 12;

// Past briefings interleaved into the responder's tail (the newest is also sent as <briefing>). Each is ~1k
// size units, so 5 was ~5k of every cold prompt, and the latest briefing supersedes the older ones anyway.
// Deliberately NOT COMPILER_TAIL_TURNS: the compiler keeps seeing its own last few briefings (5).
const RESPONDER_BRIEFING_CAP = 2;

/** Marker file inside the group's already-RW-mounted folder (`/workspace/agent`
 *  in the container) — the container-side hook reads this directly, no
 *  `container.json`/`RunnerConfig` field needed. */
function markerPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, '.projected-sessions-enabled');
}

/**
 * The key PrefixRouter's cache state (and `literal-tail`'s cache-liveness check) is filed under for a
 * projected session — null when the group isn't projected. The container sends it as `x-session-id` on
 * inference so the later `/cache-status` query finds the send; without it status always reads "expired".
 */
export function projectedSessionKeyFor(session: {
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
}): string | null {
  if (!isEnabled(session.agent_group_id)) return null;
  return sessionBriefingKey(session.agent_group_id, session.messaging_group_id, session.thread_id);
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
    // Wakes with truly nothing pending (bare on_wake respawns, host-sweep
    // self-heal) have nothing for the briefer to compile — skip the subagent
    // dispatch and reuse the last known-good briefing verbatim. Due reminders
    // (kind='task') are included in batchText precisely so this check doesn't
    // also skip those — the agent may need fresh context on the subject
    // before it delivers the reminder.
    const briefing = batchText.trim()
      ? await compileBriefing(agentGroupId, sessionId, sessionKey, batchText)
      : getSessionBriefing(sessionKey);
    // Up to RESPONDER_BRIEFING_CAP past briefings (oldest-first, includes
    // the one just compiled above), interleaved by timestamp with the raw
    // turns inside renderLiteralTail below — still written to briefing.md
    // too (just the latest), so anything reading that file directly is
    // unaffected.
    const briefingHistory = getBriefingHistoryEntries(sessionKey, RESPONDER_BRIEFING_CAP);
    // Real PrefixRouter cache-liveness check when we know the model the
    // container's own session will actually call (docs/prefixrouter-cache-status.md);
    // undefined falls back to the pure 2N-count reset inside renderLiteralTail.
    const model = getContainerConfig(agentGroupId)?.model ?? undefined;
    const tail = await renderLiteralTail(
      agentGroupId,
      sessionId,
      sessionKey,
      'responder',
      RESPONDER_TAIL_TURNS,
      briefingHistory,
      undefined,
      model,
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
