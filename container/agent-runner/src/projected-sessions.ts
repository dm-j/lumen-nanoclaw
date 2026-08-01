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
