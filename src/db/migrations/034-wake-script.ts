import type { Migration } from './index.js';

/**
 * Per-agent-group wake script on `container_configs`.
 *
 * Runs once at the start of every wake (both a scheduled `ncl tasks` fire
 * and an a2a `assign_task` session's first message — the two ways an
 * agent group with no other wiring ever wakes), before the prompt is
 * built. Same contract as a task's own `--script` (last stdout line is
 * JSON `{wakeAgent, data?}`), but unconditional on message kind — the
 * per-task `script` column only fires for `kind: 'task'` rows, which
 * misses the a2a `assign_task` wake path entirely. See
 * docs/roadmap/routine-daily-notes.md.
 */
export const migration034: Migration = {
  version: 34,
  name: 'wake-script',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN wake_script TEXT;`);
  },
};
