import type { Migration } from './index.js';

/**
 * Per-agent-group host-shim whitelist directory override on `container_configs`.
 *
 * NULL = default to `groups/<folder>/host-shims/` (resolved in
 * `src/modules/host-shim/exec.ts`), giving every agent group its own,
 * separately-scoped whitelist folder out of the box — the segregation this
 * migration exists for. A non-NULL value points a group (e.g. a shared
 * "household" group) at a different folder, such as one containing a
 * `briefing-host` with broader read access than any individual's own script.
 */
export const migration021: Migration = {
  version: 21,
  name: 'host-shims-dir',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN host_shims_dir TEXT;`);
  },
};
