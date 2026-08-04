import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-mcp-manifest-test/groups',
}));

const TEST_ROOT = '/tmp/nanoclaw-mcp-manifest-test';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { discoverMcpShims } from './mcp-manifest.js';

const GROUP_FOLDER = 'demo';
const SHIMS_DIR = path.join(TEST_ROOT, 'groups', GROUP_FOLDER, 'mcp-shims');

function writeShim(server: string, leaf: string, script: string): void {
  const dir = path.join(SHIMS_DIR, server);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${leaf}-host`);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

describe('discoverMcpShims', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    createAgentGroup({
      id: 'ag-demo',
      name: 'Demo',
      folder: GROUP_FOLDER,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns an empty list when the mcp-shims dir does not exist', () => {
    expect(discoverMcpShims('ag-demo')).toEqual([]);
  });

  it('uses --help JSON when the script provides a well-formed description/schema', () => {
    writeShim(
      'demo',
      'echo',
      `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo '{"description":"echoes input","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}'
fi
`,
    );

    const entries = discoverMcpShims('ag-demo');
    expect(entries).toEqual([
      {
        toolName: 'demo_echo',
        shimId: 'demo/echo',
        description: 'echoes input',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]);
  });

  it('falls back to a generic schema when --help is unsupported or malformed', () => {
    writeShim(
      'demo',
      'noop',
      `#!/bin/sh
exit 1
`,
    );

    const entries = discoverMcpShims('ag-demo');
    expect(entries).toEqual([
      {
        toolName: 'demo_noop',
        shimId: 'demo/noop',
        description: 'Host shim: demo/noop',
        inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } } },
      },
    ]);
  });

  it('falls back when --help prints non-JSON', () => {
    writeShim(
      'demo',
      'garbled',
      `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo 'not json'
fi
`,
    );

    const entries = discoverMcpShims('ag-demo');
    expect(entries[0].description).toBe('Host shim: demo/garbled');
  });

  it('skips non-executable scripts', () => {
    writeShim('demo', 'disabled', '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(SHIMS_DIR, 'demo', 'disabled-host'), 0o644);

    expect(discoverMcpShims('ag-demo')).toEqual([]);
  });
});
