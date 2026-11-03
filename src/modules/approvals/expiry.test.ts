/** Approval expiry sweep: overdue pending rows are dropped and the agent told; the rest are untouched. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { sweepExpiredApprovals } from './expiry.js';
import { APPROVAL_TTL_MS } from './primitive.js';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function seed(id: string, extra: { action?: string; created_at?: string; expires_at?: string | null } = {}): void {
  createPendingApproval({
    approval_id: id,
    session_id: 'sess-1',
    request_id: id,
    action: extra.action ?? 'install_packages',
    payload: '{}',
    created_at: extra.created_at ?? new Date().toISOString(),
    expires_at: extra.expires_at ?? null,
    title: 't',
    options_json: '[]',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'G', folder: 'g', agent_provider: null, created_at: new Date().toISOString() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(() => closeDb());

describe('sweepExpiredApprovals', () => {
  it('expires a row past expires_at and tells the agent not to re-request', async () => {
    seed('a', { expires_at: ago(1000) });
    await sweepExpiredApprovals();
    expect(getPendingApproval('a')).toBeUndefined();
    const text = JSON.parse(vi.mocked(writeSessionMessage).mock.calls[0][2].content).text as string;
    expect(text).toContain('install_packages request expired unanswered');
  });

  it('ages out a legacy row (no expires_at) from created_at', async () => {
    seed('old', { created_at: ago(APPROVAL_TTL_MS + 1000) });
    seed('new', { created_at: ago(1000) });
    await sweepExpiredApprovals();
    expect(getPendingApproval('old')).toBeUndefined();
    expect(getPendingApproval('new')).toBeDefined();
  });

  it('leaves unexpired rows and OneCLI rows alone', async () => {
    seed('open', { expires_at: new Date(Date.now() + 60_000).toISOString() });
    seed('onecli', { action: 'onecli_credential', expires_at: ago(1000) });
    await sweepExpiredApprovals();
    expect(getPendingApproval('open')).toBeDefined();
    expect(getPendingApproval('onecli')).toBeDefined();
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });
});
