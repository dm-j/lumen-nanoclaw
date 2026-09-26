import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-shim-registry-test';
const HOST = `${ROOT}/host-shims`;
const MCP = `${ROOT}/mcp-shims`;

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  HOST_SHIMS_DIR: '/tmp/nanoclaw-shim-registry-test/host-shims',
  MCP_SHIMS_DIR: '/tmp/nanoclaw-shim-registry-test/mcp-shims',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { execHostShim } from './exec.js';
import { discoverMcpShims } from './mcp-manifest.js';
import { pooledShimsFor } from './registry.js';

function write(file: string, script: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}
const registry = (root: string, value: unknown) =>
  fs.writeFileSync(path.join(root, '_registry.json'), typeof value === 'string' ? value : JSON.stringify(value));

describe('shim registry', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(HOST, { recursive: true });
    fs.mkdirSync(MCP, { recursive: true });
    for (const f of ['a', 'b']) {
      createAgentGroup({
        id: `ag-${f}`,
        name: f,
        folder: f,
        agent_provider: null,
        created_at: new Date().toISOString(),
      });
    }
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('is off without a registry: legacy per-group directory still works', async () => {
    write(`${HOST}/a/echo-host`, '#!/bin/sh\necho legacy\n');
    expect(pooledShimsFor('ag-a', 'host')).toBeNull();
    expect((await execHostShim('ag-a', 'echo', [])).stdout.trim()).toBe('legacy');
  });

  it('leaves a group absent from the registry on its legacy directory', async () => {
    write(`${HOST}/b/echo-host`, '#!/bin/sh\necho legacy-b\n');
    registry(HOST, { a: {} });
    expect(pooledShimsFor('ag-b', 'host')).toBeNull();
    expect((await execHostShim('ag-b', 'echo', [])).stdout.trim()).toBe('legacy-b');
  });

  it('runs an allowlisted pool script with the per-group env', async () => {
    write(`${HOST}/_pool/where-host`, '#!/bin/sh\necho "$VAULT_PATH"\n');
    registry(HOST, { a: { where: { VAULT_PATH: '/vault/a' } }, b: { where: { VAULT_PATH: '/vault/b' } } });
    expect((await execHostShim('ag-a', 'where', [])).stdout.trim()).toBe('/vault/a');
    expect((await execHostShim('ag-b', 'where', [])).stdout.trim()).toBe('/vault/b');
  });

  it('gives pooled shims a per-group state dir and their group id', async () => {
    write(
      `${HOST}/_pool/who-host`,
      '#!/bin/sh\necho "$NANOCLAW_AGENT_GROUP_ID $NANOCLAW_SHIM_STATE_DIR"\ntouch "$NANOCLAW_SHIM_STATE_DIR/x"\n',
    );
    registry(HOST, { a: { who: {} }, b: { who: {} } });
    expect((await execHostShim('ag-a', 'who', [])).stdout.trim()).toBe(`ag-a ${HOST}/_state/a`);
    expect((await execHostShim('ag-b', 'who', [])).stdout.trim()).toBe(`ag-b ${HOST}/_state/b`);
    expect(fs.existsSync(`${HOST}/_state/a/x`)).toBe(true);
    expect(fs.existsSync(`${HOST}/_pool/x`)).toBe(false);
  });

  it('refuses a pool script the group is not allowlisted for', async () => {
    write(`${HOST}/_pool/secret-host`, '#!/bin/sh\necho hi\n');
    write(`${HOST}/_pool/open-host`, '#!/bin/sh\necho hi\n');
    registry(HOST, { a: { secret: {} }, b: { open: {} } });
    expect((await execHostShim('ag-a', 'secret', [])).ok).toBe(true);
    const denied = await execHostShim('ag-b', 'secret', []);
    expect(denied.ok).toBe(false);
    expect(denied.refusalReason).toMatch(/no whitelisted shim/);
  });

  it('ignores the legacy directory once a group is in the registry', async () => {
    write(`${HOST}/a/old-host`, '#!/bin/sh\necho old\n');
    registry(HOST, { a: {} });
    expect((await execHostShim('ag-a', 'old', [])).ok).toBe(false);
  });

  it('refuses a pool symlink that escapes the pool', async () => {
    write(`${ROOT}/outside/evil.sh`, '#!/bin/sh\necho pwned\n');
    fs.mkdirSync(`${HOST}/_pool`, { recursive: true });
    fs.symlinkSync(`${ROOT}/outside/evil.sh`, `${HOST}/_pool/evil-host`);
    registry(HOST, { a: { evil: {} } });
    expect((await execHostShim('ag-a', 'evil', [])).ok).toBe(false);
  });

  it('denies everything when the registry is unreadable, instead of guessing', async () => {
    write(`${HOST}/a/echo-host`, '#!/bin/sh\necho legacy\n');
    write(`${HOST}/_pool/echo-host`, '#!/bin/sh\necho pooled\n');
    registry(HOST, '{ not json');
    expect(pooledShimsFor('ag-a', 'host')).toEqual({
      poolDir: `${HOST}/_pool`,
      stateDir: `${HOST}/_state/a`,
      shims: {},
    });
    expect((await execHostShim('ag-a', 'echo', [])).ok).toBe(false);
  });

  it('drops invalid names and non-string env values', () => {
    registry(HOST, { a: { '../x': {}, ok: { GOOD: 'yes', BAD: 3 } } });
    expect(pooledShimsFor('ag-a', 'host')?.shims).toEqual({ ok: { GOOD: 'yes' } });
  });

  it('mcp: discovers and runs only the allowlisted server/leaf shims, with env', async () => {
    const help = (d: string) =>
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo '{"description":"${d}","inputSchema":{"type":"object","properties":{}}}'; exit 0; fi\necho "$NOTE_ROOT"\n`;
    write(`${MCP}/_pool/notes/read-host`, help('reads'));
    write(`${MCP}/_pool/notes/delete-host`, help('deletes'));
    write(`${MCP}/_pool/calendar/day-host`, help('day'));
    registry(MCP, { a: { 'notes/read': { NOTE_ROOT: '/n/a' }, 'calendar/day': {} }, b: { 'notes/delete': {} } });

    expect(discoverMcpShims('ag-a').map((e) => e.toolName)).toEqual(['calendar_day', 'notes_read']);
    expect(discoverMcpShims('ag-b').map((e) => e.toolName)).toEqual(['notes_delete']);
    expect((await execHostShim('ag-a', 'notes/read', [])).stdout.trim()).toBe('/n/a');
    expect((await execHostShim('ag-a', 'notes/delete', [])).ok).toBe(false);
  });

  it('mcp: a listed shim missing from the pool is skipped, not fatal', () => {
    registry(MCP, { a: { 'notes/ghost': {} } });
    expect(discoverMcpShims('ag-a')).toEqual([]);
  });
});
