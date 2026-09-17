import fs from 'node:fs';

/**
 * Marker written by the host (src/container-runner.ts's syncStatelessMarker)
 * when the task series driving this session was created/updated with
 * `ncl tasks create/update --stateless`. Session-scoped (this session's own
 * mounted dir), not group-scoped like projected-sessions' marker — every
 * task series gets its own dedicated session, so this only needs to affect
 * that one series' resume behavior, not the whole agent group.
 */
const MARKER_PATH = '/workspace/.task-stateless';

export function isStatelessTaskSession(): boolean {
  try {
    return fs.existsSync(MARKER_PATH);
  } catch {
    return false;
  }
}
