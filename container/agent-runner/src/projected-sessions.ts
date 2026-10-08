/**
 * Container-side read half of the projected-sessions module
 * (src/modules/projected-sessions/ on the host). Self-contained: no
 * RunnerConfig/container.json field, just two conventions the host-side
 * `synthesize.ts` hook already writes into mounts this container already has:
 *
 *   /workspace/agent/.projected-sessions-enabled  — marker (groups/<folder>/,
 *     the RW mount at /workspace/agent) — presence = this session is
 *     projected. Written/removed by the host on every wake, reflecting the
 *     DB flag, so it's always current by the time a fresh container reads it.
 *   /workspace/briefing.md, /workspace/recent-turns.md — the session dir
 *     mount (/workspace), compiled fresh before this wake.
 */
import fs from 'fs';

const MARKER_PATH = '/workspace/agent/.projected-sessions-enabled';
const BRIEFING_PATH = '/workspace/briefing.md';
const RECENT_TURNS_PATH = '/workspace/recent-turns.md';

export function isProjectedSession(): boolean {
  try {
    return fs.existsSync(MARKER_PATH);
  } catch {
    return false;
  }
}

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

export interface SentContext {
  briefing: string;
  /** Every tail turn-block already shown to this query (blocks are blank-line separated). */
  blocks: Set<string>;
}

// How literal-tail.ts renders an interleaved briefing entry (host side; can't be imported here).
const BRIEFING_ENTRY = /^> \[[^\]]+\] Briefing subagent:/;

const tailBlocks = (tail: string): string[] => tail.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

/**
 * What a follow-up still needs of the briefing/tail, given what this query was already shown. The briefing
 * is resent whole only if it changed (a new one supersedes the old). The tail is a log of turns, so only
 * turn blocks not yet shown go out -- NOT "the part past the old text": the host's tail slides and resets
 * (anchored N -> 2N), so a new tail often doesn't start with the old one, and a prefix diff then resends
 * the whole thing every time (seen live: ~7.5k units per follow-up).
 */
export function contextDelta(prev: SentContext | null, cur: { briefing: string; tail: string }): { briefing: string; tail: string } {
  if (!prev) return { briefing: cur.briefing, tail: cur.tail };
  return {
    briefing: cur.briefing === prev.briefing ? '' : cur.briefing,
    // Briefing entries are skipped: each one already reached this query as a <briefing> block.
    tail: tailBlocks(cur.tail).filter((b) => !prev.blocks.has(b) && !BRIEFING_ENTRY.test(b)).join('\n\n'),
  };
}

// What the CURRENT query has been shown. Each query starts blank (continuation is never resumed for
// projected sessions), so every initial prompt resets this and only follow-ups read it.
let sent: SentContext | null = null;

/**
 * `<briefing>`/`<recent-turns>` blocks to prepend ahead of the `<context>` header, or '' if not projected.
 * `followUp`: the prompt is pushed into an already-open query that has seen the earlier blocks, so only
 * what's new is included.
 */
export function projectedContextHeader(followUp = false): string {
  if (!isProjectedSession()) return '';

  const cur = { briefing: readIfExists(BRIEFING_PATH), tail: readIfExists(RECENT_TURNS_PATH) };
  const out = contextDelta(followUp ? sent : null, cur);
  const seen = followUp && sent ? sent.blocks : new Set<string>();
  for (const b of tailBlocks(cur.tail)) seen.add(b);
  sent = { briefing: cur.briefing, blocks: seen };
  if (followUp) {
    console.error(
      `[projected] follow-up header: briefing ${out.briefing ? `resent (${out.briefing.length}B)` : 'unchanged'}, ` +
        `tail ${tailBlocks(out.tail).length} new of ${tailBlocks(cur.tail).length} blocks (${out.tail.length}B of ${cur.tail.length}B)`,
    );
  }

  const parts: string[] = [];
  if (out.briefing) parts.push(`<briefing>\n${out.briefing}\n</briefing>`);
  if (out.tail) parts.push(`<recent-turns>\n${out.tail}\n</recent-turns>`);
  return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

// ── Warm-query reset policy ──

export interface ResetInputs {
  followUpsPushed: number;
  maxFollowUps: number;
  /** ms since this container's query last saw activity (open, push, or SDK event). */
  idleMs: number;
  /** PrefixRouter's answer for this session+model; null = unknown/unreachable. */
  cacheLive: boolean | null;
  /** Used only when cacheLive is null — a plain idle-time guess at the provider's cache TTL. */
  fallbackTtlMs: number;
}

/**
 * Why a warm projected query should be dropped for a fresh spawn, or null to keep it. An expired provider
 * cache means extending the accumulated warm context is full price, while a respawn starts from the small
 * freshly compiled briefing + tail; the count caps growth even while the cache stays live.
 */
export function projectedResetReason(i: ResetInputs): string | null {
  if (i.followUpsPushed >= i.maxFollowUps) return `${i.followUpsPushed} follow-ups pushed`;
  if (i.cacheLive === false) return 'prompt cache expired';
  if (i.cacheLive === null && i.idleMs > i.fallbackTtlMs) return 'idle past fallback TTL (cache status unknown)';
  return null;
}

/** The `x-session-id` the host put in ANTHROPIC_CUSTOM_HEADERS for this container's inference calls. */
export function cacheSessionId(headers = process.env.ANTHROPIC_CUSTOM_HEADERS): string | null {
  const m = headers?.match(/^x-session-id:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

/** Ask PrefixRouter whether `model`'s prompt cache is live for this session (same endpoint the host's literal-tail uses). */
export async function queryCacheLive(
  model: string | undefined,
  baseUrl = process.env.ANTHROPIC_BASE_URL,
  sessionId = cacheSessionId(),
): Promise<boolean | null> {
  if (!model || !baseUrl || !sessionId) return null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/cache-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const { cache } = (await res.json()) as { cache?: string };
    return cache === 'live' ? true : cache === 'expired' ? false : null;
  } catch {
    return null;
  }
}
