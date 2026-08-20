import fs from 'fs';
import path from 'path';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), `nanoclaw-session-credentials-${Date.now()}`) };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { initTestDb, closeDb } = await import('../db/connection.js');
const { runMigrations } = await import('../db/migrations/index.js');
const { createAgentGroup } = await import('../db/agent-groups.js');
const { ensureContainerConfig, updateContainerConfigScalars } = await import('../db/container-configs.js');
const { sessionDir, initSessionFolder } = await import('../session-manager.js');
const { writeSessionSyncCredentials } = await import('./session-credentials.js');

function makeGroup(id: string, transport: 'file' | 'sync'): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  ensureContainerConfig(id);
  if (transport === 'sync') updateContainerConfigScalars(id, { transport: 'sync' });
  initSessionFolder(id, 'sess-1');
}

function credPath(agentGroupId: string): string {
  return path.join(sessionDir(agentGroupId, 'sess-1'), '.session-sync.json');
}

describe('writeSessionSyncCredentials', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('does not write a credentials file for a group on the default file transport', () => {
    makeGroup('ag-file', 'file');
    writeSessionSyncCredentials('ag-file', 'sess-1', 'host.docker.internal');
    expect(fs.existsSync(credPath('ag-file'))).toBe(false);
  });

  it('writes a credentials file for a group on sync transport', () => {
    makeGroup('ag-sync', 'sync');
    writeSessionSyncCredentials('ag-sync', 'sess-1', 'host.docker.internal');

    const raw = JSON.parse(fs.readFileSync(credPath('ag-sync'), 'utf8'));
    expect(raw.url).toMatch(/^wss:\/\/host\.docker\.internal:\d+$/);
    expect(typeof raw.token).toBe('string');
    expect(raw.token.split('.')).toHaveLength(3);
    expect(raw.pinnedCertPem).toContain('BEGIN CERTIFICATE');
  });

  it('removes a stale credentials file when a group is flipped back to file transport', () => {
    makeGroup('ag-flip', 'sync');
    writeSessionSyncCredentials('ag-flip', 'sess-1', 'host.docker.internal');
    expect(fs.existsSync(credPath('ag-flip'))).toBe(true);

    updateContainerConfigScalars('ag-flip', { transport: 'file' });
    writeSessionSyncCredentials('ag-flip', 'sess-1', 'host.docker.internal');
    expect(fs.existsSync(credPath('ag-flip'))).toBe(false);
  });
});
