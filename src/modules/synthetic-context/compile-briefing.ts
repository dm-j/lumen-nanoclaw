/**
 * Compiler step for `session_lifecycle = 'projected'` sessions
 * (Implementation Plan §3). Host-side, invoked from `router.ts` before a
 * session's container is woken.
 *
 * Fails closed: any missing shim / non-zero exit / timeout falls back to the
 * previously stored briefing (or empty on first turn) and never blocks the
 * responder turn.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { execHostShim } from '../host-shim/exec.js';
import { getSessionBriefing, setSessionBriefing } from '../../db/session-briefings.js';
import { renderLiteralTail } from './literal-tail.js';
import { log } from '../../log.js';

// Real Briefer calls run 20-90s in production use (Synthetic Context doc,
// 2026-07-17); the shared host-shim default (30s) is sized for cheap scripts,
// not a subagent dispatch. compile-briefing is the one caller that needs more.
const COMPILE_TIMEOUT_MS = 120_000;

// Compiler's own tail is tone/continuity only — small on purpose so it
// doesn't crowd out what the compiler is supposed to be freshly looking up.
const COMPILER_TAIL_TURNS = 6;

export function sessionBriefingKey(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
): string {
  if (!messagingGroupId) return agentGroupId; // agent-shared
  return threadId ? `${agentGroupId}:${messagingGroupId}:${threadId}` : `${agentGroupId}:${messagingGroupId}`;
}

/**
 * Compile (or fall back to) the rolling briefing for a session.
 *
 * `newBatchText` is the plain-text rendering of the inbound batch about to
 * be delivered — same content the responder itself will see, so the
 * compiler is reasoning about the same inciting message.
 */
export async function compileBriefing(
  agentGroupId: string,
  sessionId: string,
  sessionKey: string,
  newBatchText: string,
): Promise<string> {
  const prevBriefing = getSessionBriefing(sessionKey);

  const tail = renderLiteralTail(agentGroupId, sessionId, sessionKey, 'compiler', COMPILER_TAIL_TURNS);
  const batchWithTail = tail ? `## Recent turns\n\n${tail}\n\n## New message\n\n${newBatchText}` : newBatchText;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-briefing-'));
  const prevFile = path.join(tmpDir, 'prev-briefing.md');
  const batchFile = path.join(tmpDir, 'new-batch.md');

  try {
    fs.writeFileSync(prevFile, prevBriefing);
    fs.writeFileSync(batchFile, batchWithTail);

    const result = await execHostShim(agentGroupId, 'briefing', [prevFile, batchFile], COMPILE_TIMEOUT_MS);

    if (!result.ok || result.exitCode !== 0 || !result.stdout.trim()) {
      log.warn('compile-briefing: falling back to stored briefing', {
        agentGroupId,
        sessionKey,
        ok: result.ok,
        exitCode: result.exitCode,
        refusalReason: result.refusalReason,
        stderr: result.stderr?.slice(0, 500),
      });
      return prevBriefing;
    }

    const content = result.stdout.trim();
    setSessionBriefing(sessionKey, content);
    return content;
  } catch (err) {
    log.warn('compile-briefing: threw, falling back to stored briefing', { agentGroupId, sessionKey, err });
    return prevBriefing;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
