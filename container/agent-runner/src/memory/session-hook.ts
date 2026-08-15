import { renderMemorySection } from './context.js';

const MEMORY_CONTEXT_SOURCES = ['startup', 'clear', 'compact'] as const;

export type MemorySessionHookSource = (typeof MEMORY_CONTEXT_SOURCES)[number];
export type MemorySessionStartSource = MemorySessionHookSource | 'resume';

export interface MemorySessionHookRegistration {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly MemorySessionHookSource[];
}

export const MEMORY_SESSION_HOOK: MemorySessionHookRegistration = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: MEMORY_CONTEXT_SOURCES,
};

/**
 * Return memory only when a provider is establishing a new context window.
 *
 * DECISION (2026-08-14): projected-lifecycle sessions (src/modules/projected-sessions/
 * on the host) never resume a provider transcript — poll-loop.ts clears
 * `continuation` unconditionally for them, so every projected turn looks like
 * a brand-new session to the SDK and this hook always fires with
 * `source: 'startup'`, never `'resume'`. Before this fix that meant the OKF
 * memory files were re-injected on every single wake, not just true context
 * boundaries — stacking on top of the compiled `briefing.md` +
 * `recent-turns.md` that projected sessions are meant to rely on instead.
 * `isProjected` makes the skip explicit: projected sessions are treated like
 * `'resume'` unconditionally, since the briefing/tail already carries
 * continuity and interleaves briefing history itself (see
 * projected-sessions/literal-tail.ts). Resumed (non-projected) sessions are
 * completely unaffected — this only changes behavior when `isProjected` is
 * true.
 *
 * TO REVERT: delete the `isProjected` parameter and the check below; restore
 * `return source === 'resume' ? undefined : renderMemorySection(baseDir);`.
 * Also revert the two call sites that compute/pass `isProjected`
 * (container/agent-runner/src/memory/hook.ts).
 */
export function memoryContextForSessionStart(
  source: MemorySessionStartSource,
  baseDir?: string,
  isProjected = false,
): string | undefined {
  return source === 'resume' || isProjected ? undefined : renderMemorySection(baseDir);
}
