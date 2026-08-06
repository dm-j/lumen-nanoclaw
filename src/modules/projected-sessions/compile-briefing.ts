/**
 * Compiler step for projected-lifecycle sessions. Runs this agent group's
 * `briefing-host` shim against the previous briefing + the new inbound
 * batch. Fails visibly: any missing shim / non-zero exit / timeout / thrown
 * error returns an explicit failure note instead of the compiled briefing,
 * so the responder (and the user, via the responder) knows the briefer is
 * broken rather than silently working from stale context. The last known-good
 * stored briefing is left untouched either way — never blocks the responder
 * turn.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { execHostShim } from '../host-shim/exec.js';
import { appendBriefingHistory, getBriefingHistoryEntries, getSessionBriefing, setSessionBriefing } from './db.js';
import { DEFAULT_CACHE_TTL_MS, renderLiteralTail } from './literal-tail.js';
import { log } from '../../log.js';
import { LOGS_DIR } from '../../config.js';

// Single-entry rolling log, overwritten on every compile call (success or
// failure) — not the capped session_briefing_history DB rows, which are
// context for the briefer/responder, not for a human. This is purely an
// operator debugging aid: the exact prompt (prev briefing + batch + literal
// tail) and exact response, so briefing quality can be eyeballed directly
// when swapping providers/models instead of inferred secondhand from the
// responder's replies. Lives under logs/, never mounted into containers.
function writeBriefingDebugLog(agentGroupId: string, prevBriefing: string, promptBody: string, response: string): void {
  try {
    const dir = path.join(LOGS_DIR, 'briefing-debug');
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      `# Last briefing call — ${agentGroupId}`,
      `${new Date().toISOString()}`,
      '',
      '## Prompt: previous briefing (PREV_FILE)',
      '',
      prevBriefing || '(empty)',
      '',
      '## Prompt: new batch + literal tail (BATCH_FILE)',
      '',
      promptBody,
      '',
      '## Response',
      '',
      response,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `${agentGroupId}.md`), content);
  } catch (err) {
    log.warn('writeBriefingDebugLog failed (non-fatal)', { agentGroupId, err });
  }
}

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

function briefingFailureNote(errorDetail: string): string {
  return `Briefing generation failed with error: ${errorDetail}. Inform your user if they are not aware of this issue.`;
}

// Exact sentinel the briefer prompt is instructed to return verbatim when
// nothing changed (see the group's briefing-prompt.md). Matched literally,
// not persisted — see the no-op branch below.
export const NO_BRIEFING_SENTINEL =
  "No new briefing needed. For anything specific that isn't already covered above, use the recall tool.";

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

  // Up to COMPILER_TAIL_TURNS past briefings (oldest-first), interleaved by
  // timestamp with the raw turns inside renderLiteralTail below — not one
  // leading block — so the briefer sees its own recent history in the same
  // timeline as the turns it summarized, instead of jumping around (the
  // single latest one is still also passed separately as PREV_FILE below,
  // per briefing-host's established two-arg contract) — this lets the
  // briefer see its own recent history framed as "already-known context",
  // so its own instructions can tell it not to restate what's already
  // visible here.
  const briefingHistory = getBriefingHistoryEntries(sessionKey, COMPILER_TAIL_TURNS);
  // Compiler lane shells out to a fresh `claude -p --agent briefer` process
  // per call — a real API call each time, so the ephemeral prompt-cache TTL
  // is a real constraint here (see literal-tail.ts's header for why the
  // responder lane deliberately omits this).
  const tail = await renderLiteralTail(
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
      const errorDetail =
        result.refusalReason || result.stderr?.trim().slice(0, 300) || `briefing-host exited ${result.exitCode}`;
      log.warn('compile-briefing: failed, passing message through with a failure note', {
        agentGroupId,
        sessionKey,
        ok: result.ok,
        exitCode: result.exitCode,
        refusalReason: result.refusalReason,
        stderr: result.stderr?.slice(0, 500),
        stdout: result.stdout?.slice(0, 500),
      });
      // Not persisted via setSessionBriefing/appendBriefingHistory — the last
      // known-good briefing stays in place for the *next* turn's compile to
      // build on. This note is only what's shown to the responder right now.
      const failureNote = briefingFailureNote(errorDetail);
      writeBriefingDebugLog(agentGroupId, prevBriefing, batchWithTail, failureNote);
      return failureNote;
    }

    const content = result.stdout.trim();
    // A no-op briefing is shown once (returned below, written into this
    // turn's briefing.md) but never persisted — otherwise every "nothing
    // changed" turn adds its own history row and pushes the interleaved
    // tail further from the real briefings underneath it, for zero
    // information gain. prevBriefing (last real content) stays in place as
    // both what the next compile diffs against and what the responder sees
    // starting next turn.
    if (!content.startsWith('No new briefing needed.')) {
      setSessionBriefing(sessionKey, content);
      appendBriefingHistory(sessionKey, content, COMPILER_TAIL_TURNS);
    }
    writeBriefingDebugLog(agentGroupId, prevBriefing, batchWithTail, content);
    return content;
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    log.warn('compile-briefing: threw, passing message through with a failure note', {
      agentGroupId,
      sessionKey,
      err,
    });
    const failureNote = briefingFailureNote(errorDetail);
    writeBriefingDebugLog(agentGroupId, prevBriefing, batchWithTail, failureNote);
    return failureNote;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
