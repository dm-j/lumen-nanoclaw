/**
 * host-shim exec — resolve a whitelisted `<name>-host` script and run it.
 *
 * The whitelist IS the filesystem: a name is allowed iff an executable file
 * named `<name>-host` exists directly inside the calling agent group's
 * whitelist directory. No DB table of scripts, no per-script config entry —
 * add a tool by dropping one script in, remove one by deleting it.
 *
 * Segregated per agent group: each group resolves its own whitelist
 * directory (`resolveHostShimsDir`), defaulting to `host-shims/<folder>/`
 * under `HOST_SHIMS_DIR` (a sibling of `groups/`, never mounted into any
 * container) or overridden via `container_configs.host_shims_dir`. A group
 * can only ever run scripts from its own directory — this is what lets a
 * shared group (e.g. "household") point at a script with broader access
 * than any individual group's own, without individual groups gaining
 * access to it or to each other's scripts. mcp-shims (`resolveMcpShimsDir`)
 * uses the identical mechanism, same reasoning: the agent is meant to know
 * a tool by name only, never see its implementation.
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
import { HOST_SHIMS_DIR, MCP_SHIMS_DIR } from '../../config.js';
import { log } from '../../log.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// mcp-shims namespaced form: "<server>/<leaf>", each segment matching NAME_RE.
const NAMESPACED_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB cap on captured stdout/stderr

// Subagent-dispatch calls (`claude -p --agent <x>`) run 20-90s in production
// use; plain export/utility scripts don't need that long. Name-prefix
// heuristic rather than a per-job column (mirrors host-cron/run.ts's own,
// now shared from here) — revisit if a shim needs a timeout between these
// two bands. Exported so any execHostShim caller gets the same default
// without re-deriving its own list.
const LONG_TIMEOUT_MS = 180_000;
const LONG_RUNNING_PREFIXES = ['digest', 'recall', 'remember', 'briefing'];

export function timeoutFor(name: string): number {
  return LONG_RUNNING_PREFIXES.some((p) => name.startsWith(p)) ? LONG_TIMEOUT_MS : TIMEOUT_MS;
}

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
 * override if set, otherwise `host-shims/<folder>/` under `HOST_SHIMS_DIR`.
 * Every group gets its own directory by default — segregation is the
 * out-of-the-box behavior, not something a group has to opt into. Not
 * inside `groups/<folder>/`: that tree is bind-mounted RW into the group's
 * own container, so a script living inside it would be readable *and
 * writable* from inside the agent's own session — the agent is meant to
 * invoke a host-shim by name only (via the shared, read-only `host-shim`
 * CLI + IPC round-trip), never see its implementation.
 */
export function resolveHostShimsDir(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;

  const override = getContainerConfig(agentGroupId)?.host_shims_dir;
  if (override) return path.resolve(override);

  return path.join(HOST_SHIMS_DIR, group.folder);
}

/**
 * The mcp-shims whitelist directory for a given agent group: its
 * `container_configs.mcp_shims_dir` override if set, otherwise
 * `mcp-shims/<folder>/` under `MCP_SHIMS_DIR` — same off-mount-by-default
 * reasoning as `resolveHostShimsDir` just above. The one difference:
 * mcp-shims tools are registered natively via MCP (dynamic-shims.ts reads
 * container.json's pre-materialized name+schema and registers real tools
 * in-process), where host-shims tools are invoked by the agent explicitly
 * naming them via the Bash tool — different call surface, identical
 * "implementation stays host-only" guarantee.
 */
export function resolveMcpShimsDir(agentGroupId: string): string | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;

  const override = getContainerConfig(agentGroupId)?.mcp_shims_dir;
  if (override) return path.resolve(override);

  return path.join(MCP_SHIMS_DIR, group.folder);
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
  timeoutMs = timeoutFor(name),
): Promise<ShimResult> {
  const namespaced = name.includes('/');
  if (namespaced ? !NAMESPACED_NAME_RE.test(name) : !NAME_RE.test(name)) {
    return Promise.resolve(refuse(`"${name}" is not a valid shim name`));
  }

  let shimsDir: string | null;
  let leaf: string;
  if (namespaced) {
    const [server, rest] = name.split('/');
    shimsDir = resolveMcpShimsDir(agentGroupId);
    if (shimsDir) shimsDir = path.join(shimsDir, server);
    leaf = rest;
  } else {
    shimsDir = resolveHostShimsDir(agentGroupId);
    leaf = name;
  }
  if (!shimsDir) {
    log.warn('host-shim: unknown agent group', { agentGroupId, name });
    return Promise.resolve(refuse('unknown agent group'));
  }

  const shimPath = resolveShimPath(shimsDir, leaf);
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
