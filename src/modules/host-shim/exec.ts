/**
 * host-shim exec — resolve a whitelisted `<name>-host` script and run it.
 *
 * The whitelist IS the filesystem: a name is allowed iff an executable file
 * named `<name>-host` exists directly inside the calling agent group's
 * whitelist directory. No DB table of scripts, no per-script config entry —
 * add a tool by dropping one script in, remove one by deleting it.
 *
 * Segregated per agent group: each group resolves its own whitelist
 * directory (`resolveHostShimsDir`), defaulting to `groups/<folder>/host-shims/`
 * or overridden via `container_configs.host_shims_dir`. A group can only ever
 * run scripts from its own directory — this is what lets a shared group (e.g.
 * "household") point at a script with broader access than any individual
 * group's own, without individual groups gaining access to it or to each
 * other's scripts.
 *
 * Each `-host` script does its own validation of the args it receives; this
 * layer only prevents the name from escaping the whitelist directory and
 * never runs anything through a shell.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB cap on captured stdout/stderr

export interface ShimResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  refusalReason?: string;
}

function refuse(reason: string): ShimResult {
  return { ok: false, exitCode: 127, stdout: '', stderr: '', refusalReason: reason };
}

/**
 * The whitelist directory for a given agent group: its `container_configs.host_shims_dir`
 * override if set, otherwise `groups/<folder>/host-shims/`. Every group gets
 * its own directory by default — segregation is the out-of-the-box behavior,
 * not something a group has to opt into.
 */
export function resolveHostShimsDir(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;

  const override = getContainerConfig(agentGroupId)?.host_shims_dir;
  if (override) return path.resolve(override);

  return path.join(GROUPS_DIR, group.folder, 'host-shims');
}

/** Resolve `<name>-host` inside `shimsDir`, refusing anything that escapes it. */
function resolveShimPath(shimsDir: string, name: string): string | null {
  const candidate = path.join(shimsDir, `${name}-host`);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null; // doesn't exist
  }

  let realDir: string;
  try {
    realDir = fs.realpathSync(shimsDir);
  } catch {
    return null; // whitelist dir itself doesn't exist
  }
  if (!real.startsWith(realDir + path.sep)) return null; // symlink escape

  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    return null; // exists but not executable
  }

  return real;
}

export function execHostShim(
  agentGroupId: string,
  name: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<ShimResult> {
  if (!NAME_RE.test(name)) {
    return Promise.resolve(refuse(`"${name}" is not a valid shim name`));
  }

  const shimsDir = resolveHostShimsDir(agentGroupId);
  if (!shimsDir) {
    log.warn('host-shim: unknown agent group', { agentGroupId, name });
    return Promise.resolve(refuse('unknown agent group'));
  }

  const shimPath = resolveShimPath(shimsDir, name);
  if (!shimPath) {
    log.warn('host-shim: no matching whitelisted script', { agentGroupId, shimsDir, name });
    return Promise.resolve(refuse(`no whitelisted shim named "${name}"`));
  }

  return new Promise((resolve) => {
    execFile(
      shimPath,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        // execFile sets error.code to the numeric exit code on a nonzero
        // exit, or a string (e.g. 'ENOENT', 'ETIMEDOUT') if the process
        // itself failed to run — the latter has no exit code to report.
        if (error && typeof error.code !== 'number') {
          const reason = error.signal ? `killed by ${error.signal}` : error.message;
          resolve({ ok: true, exitCode: 1, stdout, stderr: stderr ? `${stderr}\n${reason}` : reason });
          return;
        }
        const exitCode = error ? (error.code as number) : 0;
        resolve({ ok: true, exitCode, stdout, stderr });
      },
    );
  });
}
