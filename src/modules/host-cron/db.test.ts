import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  computeNextRunAt,
  createHostCronJob,
  deleteHostCronJob,
  getDueHostCronJobs,
  listHostCronJobs,
  markHostCronJobRun,
} from './db.js';

describe('host-cron db', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: 'A',
      folder: 'a',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('computes an upcoming next_run_at at create time', () => {
    const job = createHostCronJob({
      agentGroupId: 'ag-1',
      name: 'export',
      args: [],
      cron: '0 0 * * *',
      timezone: 'UTC',
    });
    expect(new Date(job.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an invalid cron expression', () => {
    expect(() =>
      createHostCronJob({ agentGroupId: 'ag-1', name: 'export', args: [], cron: 'not a cron', timezone: 'UTC' }),
    ).toThrow(/invalid --cron/);
  });

  it('a job scheduled in the past is due; a job scheduled for the far future is not', () => {
    const due = createHostCronJob({
      agentGroupId: 'ag-1',
      name: 'due-job',
      args: [],
      cron: '* * * * *',
      timezone: 'UTC',
    });
    // Force next_run_at into the past directly (create() always computes a future fire).
    getDb().prepare('UPDATE host_cron_jobs SET next_run_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', due.id);

    createHostCronJob({ agentGroupId: 'ag-1', name: 'not-due-job', args: [], cron: '0 0 1 1 *', timezone: 'UTC' });

    const dueJobs = getDueHostCronJobs();
    expect(dueJobs.map((j) => j.name)).toEqual(['due-job']);
  });

  it('markHostCronJobRun stamps last_run_at and arms a fresh next_run_at', () => {
    const job = createHostCronJob({
      agentGroupId: 'ag-1',
      name: 'export',
      args: [],
      cron: '0 0 * * *',
      timezone: 'UTC',
    });
    const ranAt = new Date().toISOString();
    markHostCronJobRun(job, ranAt);

    const [updated] = listHostCronJobs('ag-1');
    expect(updated.last_run_at).toBe(ranAt);
    expect(new Date(updated.next_run_at).getTime()).toBeGreaterThan(new Date(ranAt).getTime());
  });

  it('listHostCronJobs scopes to an agent group', () => {
    createAgentGroup({
      id: 'ag-2',
      name: 'B',
      folder: 'b',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createHostCronJob({ agentGroupId: 'ag-1', name: 'a', args: [], cron: '0 0 * * *', timezone: 'UTC' });
    createHostCronJob({ agentGroupId: 'ag-2', name: 'b', args: [], cron: '0 0 * * *', timezone: 'UTC' });

    expect(listHostCronJobs('ag-1')).toHaveLength(1);
    expect(listHostCronJobs()).toHaveLength(2);
  });

  it('deleteHostCronJob removes the row', () => {
    const job = createHostCronJob({
      agentGroupId: 'ag-1',
      name: 'export',
      args: [],
      cron: '0 0 * * *',
      timezone: 'UTC',
    });
    deleteHostCronJob(job.id);
    expect(listHostCronJobs('ag-1')).toHaveLength(0);
  });

  it('computeNextRunAt is deterministic given an explicit "from" date', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const next = computeNextRunAt('0 12 * * *', 'UTC', from);
    expect(next).toBe('2026-01-01T12:00:00.000Z');
  });
});
