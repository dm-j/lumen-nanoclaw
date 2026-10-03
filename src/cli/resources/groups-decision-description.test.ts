/**
 * `agent_groups.decision_description` (migration 035): the agent's self-description,
 * one option in a list for a Jev-style decision model. Separate from `description`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { getAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

const GID = 'ag-dd-test';

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: GID,
    name: 'DD Test',
    folder: 'dd-test',
    agent_provider: null,
    description: 'routing hint for an LLM',
    created_at: new Date().toISOString(),
  });
});

afterEach(() => closeDb());

describe('agent_groups.decision_description', () => {
  it('is added by migration 035 and starts NULL, independent of description', () => {
    const cols = getDb().prepare('PRAGMA table_info(agent_groups)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('decision_description');
    const row = getAgentGroup(GID)!;
    expect(row.decision_description).toBeNull();
    expect(row.description).toBe('routing hint for an LLM');
  });

  it('is set and read back through `ncl groups update` / `get`, leaving description alone', async () => {
    const text =
      'Looks things up in the vault or on the web and cites sources. Does not schedule, calculate or edit notes.';
    const upd = await dispatch(
      { id: 'u1', command: 'groups-update', args: { id: GID, decision_description: text } },
      { caller: 'host' },
    );
    expect(upd.ok).toBe(true);

    const got = await dispatch({ id: 'g1', command: 'groups-get', args: { id: GID } }, { caller: 'host' });
    expect(got.ok).toBe(true);
    const data = (got as { ok: true; data: { decision_description: string; description: string } }).data;
    expect(data.decision_description).toBe(text);
    expect(data.description).toBe('routing hint for an LLM');
  });

  it('can be updated on its own through updateAgentGroup, and an unset field is left unchanged', () => {
    updateAgentGroup(GID, { decision_description: 'first' });
    updateAgentGroup(GID, { description: 'new hint' });
    const row = getAgentGroup(GID)!;
    expect(row.decision_description).toBe('first');
    expect(row.description).toBe('new hint');
  });

  it('rows created before the column existed read back as NULL, not undefined or ""', () => {
    getDb()
      .prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-old', 'Old', 'old', '2026-01-01')")
      .run();
    expect(getAgentGroup('ag-old')!.decision_description).toBeNull();
  });
});
