import os from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests must never write into the real host-shims/ and mcp-shims/ trees (they are symlinks into the
    // instance repo, so group-init in a test used to litter it with test-group folders).
    env: {
      NANOCLAW_HOST_SHIMS_DIR: path.join(os.tmpdir(), 'nanoclaw-vitest-host-shims'),
      NANOCLAW_MCP_SHIMS_DIR: path.join(os.tmpdir(), 'nanoclaw-vitest-mcp-shims'),
    },
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
  },
});
