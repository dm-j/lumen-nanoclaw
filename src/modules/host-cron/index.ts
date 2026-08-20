/**
 * host-cron module.
 *
 * Lets an agent group schedule a host-shim script (add-host-scripts) to run
 * on a cron schedule, independent of any inbound message — no container
 * spawn, no conversation cost. Fully self-contained: own migration (026),
 * own table, own CLI resource (`ncl host-cron-jobs create|list|delete|run`).
 * The tick itself (src/modules/host-cron/run.ts) is wired from
 * src/host-sweep.ts's existing 60s sweep via one hasTable-gated call —
 * no new timer.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerResource } from '../../cli/crud.js';
import {
  computeNextRunAt,
  createHostCronJob,
  deleteHostCronJob,
  getHostCronJob,
  listHostCronJobs,
  markHostCronJobRun,
} from './db.js';
import { runDueHostCronJobs } from './run.js';

function parseArgs(value: unknown): string[] {
  if (value === undefined) return [];
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
      throw new Error('not a string[]');
    }
    return parsed as string[];
  } catch {
    throw new Error(`--args must be a JSON string array, e.g. '["a","b"]' (got: ${raw})`);
  }
}

registerResource({
  name: 'host-cron-job',
  plural: 'host-cron-jobs',
  table: 'host_cron_jobs',
  description:
    'Schedule a host-shim script (see /add-host-scripts) to run on a cron schedule, independent of any ' +
    'inbound message — no container spawn, no conversation cost. The named script must exist as ' +
    "`<name>-host` in the target group's host-shim whitelist folder; this resource has no opinion on " +
    'what the script does.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Auto-generated.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'The agent group. References agent_groups.id.' },
    { name: 'name', type: 'string', description: 'Host-shim script name (without the -host suffix).' },
    { name: 'args', type: 'json', description: 'JSON string array of args passed to the script.' },
    { name: 'cron', type: 'string', description: 'Cron expression (5-field).' },
    { name: 'timezone', type: 'string', description: "IANA id; NULL follows the group's own timezone." },
    { name: 'next_run_at', type: 'string', description: 'Auto-computed.', generated: true },
    { name: 'last_run_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: {},
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create a host-cron job. Use --id <group-id>, --name <script>, --cron "<expr>", ' +
        'optional --args \'["a","b"]\' and --timezone <iana>.',
      handler: async (args) => {
        const agentGroupId = args.id as string;
        if (!agentGroupId) throw new Error('--id is required');
        if (!getAgentGroup(agentGroupId)) throw new Error(`group not found: ${agentGroupId}`);
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const cron = args.cron as string;
        if (!cron) throw new Error('--cron is required');
        const timezone = (args.timezone as string | undefined) || undefined;
        const job = createHostCronJob({ agentGroupId, name, args: parseArgs(args.args), cron, timezone });
        return job;
      },
    },
    list: {
      access: 'open',
      description: 'List host-cron jobs, optionally scoped to --id <group-id>.',
      handler: async (args) => listHostCronJobs(args.id as string | undefined),
    },
    delete: {
      access: 'approval',
      description: 'Delete a host-cron job. Use --job-id <id>.',
      handler: async (args) => {
        const jobId = args['job-id'] ?? args.job_id;
        if (!jobId) throw new Error('--job-id is required');
        deleteHostCronJob(jobId as string);
        return { deleted: jobId };
      },
    },
    run: {
      access: 'approval',
      description: 'Force-run one job now (ignores next_run_at), then reschedules normally. Use --job-id <id>.',
      handler: async (args) => {
        const jobId = args['job-id'] ?? args.job_id;
        if (!jobId) throw new Error('--job-id is required');
        const job = getHostCronJob(jobId as string);
        if (!job) throw new Error(`job not found: ${jobId}`);
        const { execHostShim } = await import('../host-shim/exec.js');
        const ranAt = new Date().toISOString();
        const result = await execHostShim(job.agent_group_id, job.name, JSON.parse(job.args) as string[]);
        markHostCronJobRun(job, ranAt);
        return { jobId, ...result };
      },
    },
  },
});

export { runDueHostCronJobs, computeNextRunAt };
