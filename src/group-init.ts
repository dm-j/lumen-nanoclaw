import fs from 'fs';
import path from 'path';

import { DATA_DIR, DEFAULT_AGENT_PROVIDER, GROUPS_DIR, HOST_SHIM_TEMPLATES_DIR } from './config.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { stageGroupPersona } from './group-persona.js';
import { log } from './log.js';
import { migrateClaudeMemorySettings } from './migrate-claude-memory-settings.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      autoMemoryEnabled: false,
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The provider project document is regenerated on every spawn. Initial
 * standing instructions are staged once in the provider-neutral prepend file.
 */
export function initGroupFilesystem(
  group: AgentGroup,
  opts?: { instructions?: string; provider?: string | null },
): void {
  const initialized: string[] = [];

  // `opts.provider` absent means "caller has no provider opinion" — for a
  // brand-new group that resolves to the instance default, so the scaffold and
  // the stamped config row both match it. A caller that knows the provider
  // (subagent → parent's, spawn → resolved, setup → operator's pick) passes it
  // explicitly — including `claude` — which pins the group and skips the
  // default. ensureContainerConfig is INSERT OR IGNORE, so this only stamps a
  // genuinely new group; existing rows are never touched.
  const providerHint = (opts?.provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();

  // Default agent surfaces apply unless the provider declares (at registration)
  // that it provides its own.
  const defaultSurfaces = !providerProvidesAgentSurfaces(providerHint);

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  if (opts?.instructions && stageGroupPersona(groupDir, opts.instructions)) {
    initialized.push('instructions.prepend.md');
  }

  // host-shims/ — this group's own host-shim whitelist directory (default
  // location per resolveHostShimsDir; container_configs.host_shims_dir can
  // override it). Seeded with the default briefing-host script
  // (src/host-shim-templates/briefing-host), copied once and never
  // overwritten again — a group's own edits (e.g. its VAULT_PATH) must
  // survive every future spawn/restart.
  const hostShimsDir = path.join(groupDir, 'host-shims');
  if (!fs.existsSync(hostShimsDir)) {
    fs.mkdirSync(hostShimsDir, { recursive: true });
    initialized.push('host-shims/');
  }
  // transcript-append-host, digest-daily-host: same seed-once-never-overwrite
  // treatment, for the vault memory pipeline (live per-turn transcript
  // export + scheduled daily digest generation via add-host-cron).
  for (const shimName of ['briefing-host', 'transcript-append-host', 'digest-daily-host', 'digest-rollup-host']) {
    const shimDst = path.join(hostShimsDir, shimName);
    const shimSrc = path.join(HOST_SHIM_TEMPLATES_DIR, shimName);
    if (!fs.existsSync(shimDst) && fs.existsSync(shimSrc)) {
      fs.copyFileSync(shimSrc, shimDst);
      fs.chmodSync(shimDst, 0o755);
      initialized.push(`host-shims/${shimName}`);
    }
  }

  // mcp-shims/ — this group's own dynamic MCP-tool whitelist directory.
  // Same isolation model as host-shims/ (a subfolder script is invisible to
  // every other group) but auto-exposed as an MCP tool per script instead of
  // requiring a Bash-tool call. Empty by default — no seeded scripts.
  const mcpShimsDir = path.join(groupDir, 'mcp-shims');
  if (!fs.existsSync(mcpShimsDir)) {
    fs.mkdirSync(mcpShimsDir, { recursive: true });
    initialized.push('mcp-shims/');
  }

  // Ensure container_configs row exists in the DB. Idempotent — no-op if
  // the row already exists (e.g. created by backfill or group creation). On a
  // fresh row, stamp the resolved provider hint so a new group is created on
  // the instance default (or the caller's explicit pick).
  ensureContainerConfig(group.id, providerHint);
  initialized.push('container_configs');

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  if (defaultSurfaces) {
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      initialized.push('.claude-shared');
    }

    const settingsFile = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
      initialized.push('settings.json');
    } else if (migrateClaudeMemorySettings(settingsFile)) {
      initialized.push('settings.json (reconciled Claude settings)');
    }

    // Skills directory — created empty here; symlinks are synced at spawn
    // time by container-runner.ts based on container.json skills selection.
    const skillsDst = path.join(claudeDir, 'skills');
    if (!fs.existsSync(skillsDst)) {
      fs.mkdirSync(skillsDst, { recursive: true });
      initialized.push('skills/');
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}
