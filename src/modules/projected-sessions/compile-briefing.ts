/**
 * Compiler step for projected-lifecycle sessions. Runs this agent group's
 * `briefing-host` shim against the previous briefing + the new inbound
 * batch. Fails closed: any missing shim / non-zero exit / timeout falls
 * back to the previously stored briefing (or empty on first turn) and never
 * blocks the responder turn.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { execHostShim } from '../host-shim/exec.js';
import { appendBriefingHistory, getBriefingHistoryText, getSessionBriefing, setSessionBriefing } from './db.js';
import { DEFAULT_CACHE_TTL_MS, renderLiteralTail } from './literal-tail.js';
import { log } from '../../log.js';

// Real Briefer calls run 20-90s in production use (Synthetic Context doc,
// 2026-07-17); the shared host-shim default (30s) is sized for cheap scripts,
// not a subagent dispatch. compile-briefing is the one caller that needs more.
// Bumped from 120s once briefing-host started routing through
// PrefixRouter/Ollama, whose round-trips run slower than Anthropic's.
const COMPILE_TIMEOUT_MS = 180_000;

// Compiler's own tail is tone/continuity only — small on purpose so it
// doesn't crowd out what the compiler is supposed to be freshly looking up.
// Also the cap on the briefing-history block shown to BOTH compiler and
// responder — a briefing ages out of context at the same rate for both
// sides (synthesize.ts imports this same constant for its own cap).
export const COMPILER_TAIL_TURNS = 5;

export function sessionBriefingKey(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
): string {
  if (!messagingGroupId) return agentGroupId; // agent-shared
  return threadId ? `${agentGroupId}:${messagingGroupId}:${threadId}` : `${agentGroupId}:${messagingGroupId}`;
}

export async function compileBriefing(
  agentGroupId: string,
  sessionId: string,
  sessionKey: string,
  newBatchText: string,
): Promise<string> {
  const prevBriefing = getSessionBriefing(sessionKey);

  // Up to COMPILER_TAIL_TURNS past briefings (oldest-first), folded into the
  // tail as an uncounted leading block (the single latest one is still also
  // passed separately as PREV_FILE below, per briefing-host's established
  // two-arg contract) — this lets the briefer see its own recent history
  // framed as "already-known context", so its own instructions can tell it
  // not to restate what's already visible here.
  const briefingHistory = getBriefingHistoryText(sessionKey, COMPILER_TAIL_TURNS);
  // Compiler lane shells out to a fresh `claude -p --agent briefer` process
  // per call — a real API call each time, so the ephemeral prompt-cache TTL
  // is a real constraint here (see literal-tail.ts's header for why the
  // responder lane deliberately omits this).
  const tail = renderLiteralTail(
    agentGroupId,
    sessionId,
    sessionKey,
    'compiler',
    COMPILER_TAIL_TURNS,
    briefingHistory,
    DEFAULT_CACHE_TTL_MS,
  );
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
        stdout: result.stdout?.slice(0, 500),
      });
      return prevBriefing;
    }

    const content = result.stdout.trim();
    setSessionBriefing(sessionKey, content);
    appendBriefingHistory(sessionKey, content, COMPILER_TAIL_TURNS);
    return content;
  } catch (err) {
    log.warn('compile-briefing: threw, falling back to stored briefing', { agentGroupId, sessionKey, err });
    return prevBriefing;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
