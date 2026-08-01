/**
 * DB access for the host-cron module. Owns one table entirely (migration
 * 026) — no reach-in to any core table.
 */
import { randomUUID } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import { getDb } from '../../db/connection.js';
import { resolveGroupTimezone } from '../../container-config.js';

export interface HostCronJob {
  id: string;
  agent_group_id: string;
  name: string;
  args: string; // JSON string[]
  cron: string;
  timezone: string | null;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
}

/** Validates the cron expression; throws with a clear message if invalid. Same shape as validateRecurrence. */
export function computeNextRunAt(cron: string, tz: string, from?: Date): string {
  let next: string | null;
  try {
    next = CronExpressionParser.parse(cron, { tz, currentDate: from }).next().toISOString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid --cron: ${msg}`, { cause: err });
  }
  if (!next) throw new Error(`--cron has no upcoming run: ${cron}`);
  return next;
}

export function createHostCronJob(params: {
  agentGroupId: string;
  name: string;
  args: string[];
  cron: string;
  timezone?: string | null;
}): HostCronJob {
  const tz = params.timezone ?? resolveGroupTimezone(params.agentGroupId);
  const nextRunAt = computeNextRunAt(params.cron, tz);
  const row: HostCronJob = {
    id: `hostcron-${Date.now()}-${randomUUID().slice(0, 8)}`,
    agent_group_id: params.agentGroupId,
    name: params.name,
    args: JSON.stringify(params.args),
    cron: params.cron,
    timezone: params.timezone ?? null,
    next_run_at: nextRunAt,
    last_run_at: null,
    created_at: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT INTO host_cron_jobs (id, agent_group_id, name, args, cron, timezone, next_run_at, last_run_at, created_at)
       VALUES (@id, @agent_group_id, @name, @args, @cron, @timezone, @next_run_at, @last_run_at, @created_at)`,
    )
    .run(row);
  return row;
}

export function getDueHostCronJobs(): HostCronJob[] {
  return getDb().prepare(`SELECT * FROM host_cron_jobs WHERE next_run_at <= datetime('now')`).all() as HostCronJob[];
}

export function getHostCronJob(id: string): HostCronJob | undefined {
  return getDb().prepare('SELECT * FROM host_cron_jobs WHERE id = ?').get(id) as HostCronJob | undefined;
}

export function listHostCronJobs(agentGroupId?: string): HostCronJob[] {
  if (agentGroupId) {
    return getDb()
      .prepare('SELECT * FROM host_cron_jobs WHERE agent_group_id = ? ORDER BY next_run_at')
      .all(agentGroupId) as HostCronJob[];
  }
  return getDb().prepare('SELECT * FROM host_cron_jobs ORDER BY next_run_at').all() as HostCronJob[];
}

export function deleteHostCronJob(id: string): void {
  getDb().prepare('DELETE FROM host_cron_jobs WHERE id = ?').run(id);
}

/** Stamp a completed run and arm the next fire — same "arm, don't re-derive" pattern as task recurrence. */
export function markHostCronJobRun(job: HostCronJob, ranAt: string): void {
  const tz = job.timezone ?? resolveGroupTimezone(job.agent_group_id);
  const nextRunAt = computeNextRunAt(job.cron, tz, new Date(ranAt));
  getDb()
    .prepare('UPDATE host_cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?')
    .run(ranAt, nextRunAt, job.id);
}
