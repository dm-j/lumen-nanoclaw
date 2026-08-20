import type { Migration } from './index.js';

/**
 * Per-agent-group mcp-shims whitelist directory override on
 * `container_configs` — mirrors migration 021's `host_shims_dir`.
 *
 * NULL = default to `groups/<folder>/mcp-shims/` (resolved in
 * `src/modules/host-shim/exec.ts`). A non-NULL value points a group at a
 * directory outside its own mounted workspace — so the agent gets a
 * harmless generic forwarder (the container's dynamic-shims MCP tool,
 * already implementation-free) while the actual `<name>-host` scripts never
 * enter its filesystem at all, closing the gap where `groups/<folder>/` is
 * bind-mounted RW into the container and mcp-shims/ had no dedicated
 * read-only (or off-mount) protection the way CLAUDE.md/container.json do.
 */
export const migration029: Migration = {
  version: 29,
  name: 'mcp-shims-dir',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN mcp_shims_dir TEXT;`);
  },
};
