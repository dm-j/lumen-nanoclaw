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

/** `<briefing>`/`<recent-turns>` blocks to prepend ahead of the `<context>` header, or '' if not projected. */
export function projectedContextHeader(): string {
  if (!isProjectedSession()) return '';

  const parts: string[] = [];
  const briefing = readIfExists(BRIEFING_PATH);
  if (briefing) parts.push(`<briefing>\n${briefing}\n</briefing>`);
  const tail = readIfExists(RECENT_TURNS_PATH);
  if (tail) parts.push(`<recent-turns>\n${tail}\n</recent-turns>`);
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
