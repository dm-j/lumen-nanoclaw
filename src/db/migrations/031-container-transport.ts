import type { Migration } from './index.js';

/**
 * Per-agent-group session transport on `container_configs`.
 *
 * 'file'  — today's behavior: inbound.db/outbound.db bind-mounted into the
 *           container. Default. The only option on Linux hosts, which have
 *           no VirtioFS layer and no evidence of the corruption this exists
 *           to work around.
 * 'sync'  — host-local + container-local SQLite reconciled over a WebSocket
 *           sync channel (see docs/db.md). Opt-in per group until proven out.
 *
 * NULL means 'file' — existing rows need no backfill.
 */
export const migration031: Migration = {
  version: 31,
  name: 'container-transport',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN transport TEXT;`);
  },
};
