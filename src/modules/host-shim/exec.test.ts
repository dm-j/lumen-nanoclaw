import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createContainerConfig } from '../../db/container-configs.js';
import type { ContainerConfigRow } from '../../types.js';

describe('execHostShim', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    const db = initTestDb();
    runMigrations(db);

    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'host-shims-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'host-shims-b-'));

    createAgentGroup({
      id: 'ag-a',
      name: 'A',
      folder: 'a',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createAgentGroup({
      id: 'ag-b',
      name: 'B',
      folder: 'b',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const base: Omit<ContainerConfigRow, 'agent_group_id' | 'host_shims_dir'> = {
      provider: null,
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: '"all"',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      cli_scope: 'group',
      timezone: null,
      session_lifecycle: null,
      updated_at: new Date().toISOString(),
    };
    createContainerConfig({ ...base, agent_group_id: 'ag-a', host_shims_dir: dirA });
    createContainerConfig({ ...base, agent_group_id: 'ag-b', host_shims_dir: dirB });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  function writeShim(dir: string, name: string, script: string) {
    const p = path.join(dir, `${name}-host`);
    fs.writeFileSync(p, script);
    fs.chmodSync(p, 0o755);
  }

  it('refuses an invalid name before touching the filesystem', async () => {
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-a', '../etc', []);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  it('refuses an unknown agent group', async () => {
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-nonexistent', 'echo', []);
    expect(result.ok).toBe(false);
    expect(result.refusalReason).toMatch(/unknown agent group/);
  });

  it('refuses a name with no matching -host script', async () => {
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-a', 'nonexistent', []);
    expect(result.ok).toBe(false);
    expect(result.refusalReason).toMatch(/no whitelisted shim/);
  });

  it('runs a whitelisted script and returns its output', async () => {
    writeShim(dirA, 'echo', '#!/bin/sh\necho "$@"\n');
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-a', 'echo', ['hello', 'world']);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('propagates a nonzero exit code from the script', async () => {
    writeShim(dirA, 'fail', '#!/bin/sh\nexit 3\n');
    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-a', 'fail', []);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(3);
  });

  it('refuses a symlink that escapes the whitelist directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'host-shims-outside-'));
    const target = path.join(outside, 'evil.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho pwned\n');
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(dirA, 'escape-host'));

    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-a', 'escape', []);
    expect(result.ok).toBe(false);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a non-executable file', async () => {
    const p = path.join(dirA, 'notexec-host');
    fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
    fs.chmodSync(p, 0o644);

    const { execHostShim } = await import('./exec.js');
    const result = await execHostShim('ag-a', 'notexec', []);
    expect(result.ok).toBe(false);
  });

  it('segregates groups: a script in group A is invisible to group B', async () => {
    writeShim(dirA, 'secret', '#!/bin/sh\necho "a-only"\n');
    const { execHostShim } = await import('./exec.js');

    const asA = await execHostShim('ag-a', 'secret', []);
    expect(asA.ok).toBe(true);
    expect(asA.stdout.trim()).toBe('a-only');

    const asB = await execHostShim('ag-b', 'secret', []);
    expect(asB.ok).toBe(false);
    expect(asB.refusalReason).toMatch(/no whitelisted shim/);
  });
});
