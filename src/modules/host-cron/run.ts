/**
 * Tick logic — called from src/host-sweep.ts's existing 60s sweep, gated on
 * hasTable('host_cron_jobs') so this module costs nothing when absent.
 *
 * A due job is just a named host-shim script (add-host-scripts) run with
 * its stored args — this module has no opinion on what the script does.
 * A failed run still reschedules (no in-period retry/backoff — the next
 * scheduled fire already is the retry) so one bad run can't wedge a job
 * into permanent silence.
 */
import { execHostShim } from '../host-shim/exec.js';
import { log } from '../../log.js';
import { getDueHostCronJobs, markHostCronJobRun } from './db.js';

// Digester-style calls (subagent dispatch against a day's worth of
// transcript) run long; plain export/utility scripts don't need it. Kept as
// a simple name-prefix heuristic here rather than a new per-job column —
// revisit if a job needs a timeout between these two bands.
const DEFAULT_TIMEOUT_MS = 60_000;
const LONG_TIMEOUT_MS = 180_000;
const LONG_RUNNING_PREFIXES = ['digest'];

function timeoutFor(name: string): number {
  return LONG_RUNNING_PREFIXES.some((p) => name.startsWith(p)) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export async function runDueHostCronJobs(): Promise<void> {
  for (const job of getDueHostCronJobs()) {
    const ranAt = new Date().toISOString();
    try {
      const args = JSON.parse(job.args) as string[];
      const result = await execHostShim(job.agent_group_id, job.name, args, timeoutFor(job.name));
      if (!result.ok || result.exitCode !== 0) {
        log.warn('host-cron job failed', {
          jobId: job.id,
          name: job.name,
          agentGroupId: job.agent_group_id,
          exitCode: result.exitCode,
          refusalReason: result.refusalReason,
          stderr: result.stderr?.slice(0, 500),
        });
      }
    } catch (err) {
      log.warn('host-cron job threw', { jobId: job.id, name: job.name, agentGroupId: job.agent_group_id, err });
    }
    markHostCronJobRun(job, ranAt);
  }
}
