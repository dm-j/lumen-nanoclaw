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
  tail: string;
}

/**
 * What a follow-up still needs of the briefing/tail, given what this query was already shown: the
 * briefing only if it changed, and the tail only past what was sent (the host's tail grows append-only
 * N -> 2N between resets; after a reset it no longer extends what we sent, so it goes out in full).
 * Without this every follow-up re-injects a whole copy of both, ~97% of each follow-up's growth.
 */
export function contextDelta(prev: SentContext | null, cur: SentContext): SentContext {
  if (!prev) return cur;
  return {
    briefing: cur.briefing === prev.briefing ? '' : cur.briefing,
    tail: cur.tail.startsWith(prev.tail) ? cur.tail.slice(prev.tail.length).trim() : cur.tail,
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
  sent = cur;

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
