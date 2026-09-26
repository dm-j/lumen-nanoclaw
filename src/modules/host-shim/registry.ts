/**
 * Shim registry — one central pool of scripts, plus a per-group allowlist.
 *
 * Without a registry each group owns a private copy of every script it may run
 * (`host-shims/<folder>/<name>-host`, `mcp-shims/<folder>/<server>/<name>-host`). With one, the scripts
 * live once in `<root>/_pool/` and `<root>/_registry.json` says which group gets which:
 *
 *   { "<group folder>": { "<shim name>": { "ENV_VAR": "per-group value" }, ... }, ... }
 *
 * host-shims name a shim `briefing`; mcp-shims name it `<server>/<leaf>` (both resolve to
 * `_pool/<name>-host`). The env object is passed to the script, which is how a shared script
 * gets its per-group setting (e.g. VAULT_PATH) instead of an edited private copy.
 *
 * Opt-in per group: a group absent from the registry (or with an explicit `host_shims_dir` /
 * `mcp_shims_dir` override) keeps the legacy per-group directory. A group present gets exactly its
 * allowlist — nothing from a legacy directory. A registry that exists but cannot be parsed denies
 * everything rather than silently handing a group the wrong tools. The file is re-read on every
 * call, so edits apply without a restart, like the filesystem whitelist it sits beside.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { HOST_SHIMS_DIR, MCP_SHIMS_DIR } from '../../config.js';
import { log } from '../../log.js';

export type ShimKind = 'host' | 'mcp';

export const REGISTRY_FILE = '_registry.json';
export const POOL_DIR = '_pool';
export const STATE_DIR = '_state';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// mcp-shims namespaced form: "<server>/<leaf>", each segment matching NAME_RE.
export const NAMESPACED_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PooledShims {
  /** Directory holding the shared scripts (`<root>/_pool`). */
  poolDir: string;
  /** Per-group scratch directory (`<root>/_state/<folder>`) for logs and checkpoints a shim writes. */
  stateDir: string;
  /** Allowed shim name → env to pass it. */
  shims: Record<string, Record<string, string>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The group's pooled allowlist, or null when the group uses its legacy per-group directory. */
export function pooledShimsFor(agentGroupId: string, kind: ShimKind): PooledShims | null {
  const group = getAgentGroup(agentGroupId);
  if (!group) return null;

  const config = getContainerConfig(agentGroupId);
  if (kind === 'host' ? config?.host_shims_dir : config?.mcp_shims_dir) return null;

  const root = kind === 'host' ? HOST_SHIMS_DIR : MCP_SHIMS_DIR;
  const poolDir = path.join(root, POOL_DIR);
  const stateDir = path.join(root, STATE_DIR, group.folder);
  const registryPath = path.join(root, REGISTRY_FILE);

  let registry: unknown;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!isRecord(registry)) throw new Error('top level must be an object');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // no registry: legacy behaviour
    log.error('shim registry unreadable — denying every pooled shim until it is fixed', { registryPath, err });
    return { poolDir, stateDir, shims: {} };
  }

  const entry = (registry as Record<string, unknown>)[group.folder];
  if (entry === undefined) return null;
  if (!isRecord(entry)) {
    log.error('shim registry entry is not an object — denying this group', { registryPath, folder: group.folder });
    return { poolDir, stateDir, shims: {} };
  }

  const nameRe = kind === 'host' ? NAME_RE : NAMESPACED_NAME_RE;
  const shims: Record<string, Record<string, string>> = {};
  for (const [name, env] of Object.entries(entry)) {
    if (!nameRe.test(name)) {
      log.warn('shim registry: ignoring invalid shim name', { registryPath, folder: group.folder, name });
      continue;
    }
    shims[name] = Object.fromEntries(
      Object.entries(isRecord(env) ? env : {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
    );
  }
  return { poolDir, stateDir, shims };
}
