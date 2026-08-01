import type { Migration } from './index.js';

/**
 * Schema for the `host-cron` module (src/modules/host-cron/).
 *
 * Lets an agent group schedule a host-shim script (add-host-scripts) to run
 * on a cron schedule, independent of any inbound message — no container
 * spawn, no conversation cost. `next_run_at` is precomputed at create/run
 * time (mirrors task recurrence's own "arm for the next fire" pattern in
 * src/modules/scheduling/db.ts) rather than re-derived from `cron` fresh on
 * every sweep tick — avoids ambiguity/double-firing under clock or tick
 * jitter. `timezone` NULL follows resolveGroupTimezone(agent_group_id),
 * same convention as `container_configs.timezone`.
 */
export const migration026: Migration = {
  version: 26,
  name: 'host-cron',
  up(db) {
    db.exec(`
      CREATE TABLE host_cron_jobs (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        name           TEXT NOT NULL,
        args           TEXT NOT NULL DEFAULT '[]',
        cron           TEXT NOT NULL,
        timezone       TEXT,
        next_run_at    TEXT NOT NULL,
        last_run_at    TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX idx_host_cron_jobs_next_run_at ON host_cron_jobs(next_run_at);
    `);
  },
};
