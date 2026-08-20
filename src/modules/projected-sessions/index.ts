/**
 * projected-sessions module.
 *
 * Opt-in per agent group: an agent group with a row in
 * `projected_sessions_enabled` never resumes its provider transcript.
 * Instead, on every wake (`container-runner.ts`'s hasTable-gated hook —
 * see `synthesize.ts`), a host-side compiler produces a rolling briefing +
 * a prefix-cache-aware literal tail, written into the session dir the
 * container already mounts at `/workspace`.
 *
 * Fully self-contained: own migration (025), own tables, own CLI resource
 * (`ncl projected-sessions enable|disable|list`) — no reach-in to
 * `container_configs`, `src/types.ts`, or `src/cli/resources/groups.ts`.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerResource } from '../../cli/crud.js';
import { isEnabled, listEnabled, setEnabled } from './db.js';

registerResource({
  name: 'projected-session',
  plural: 'projected-sessions',
  table: 'projected_sessions_enabled',
  description:
    'Opt-in per-agent-group session lifecycle: enabled groups get a host-compiled briefing + literal tail ' +
    'instead of resuming their provider transcript every turn. Requires this group to have a `briefing-host` ' +
    'script in its host-shim whitelist folder (see /add-host-shim). Restart the group after enabling/disabling.',
  idColumn: 'agent_group_id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'agent_group_id', type: 'string', description: 'The agent group. References agent_groups.id.' },
    { name: 'enabled_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List agent groups with projected sessions enabled.',
      handler: async () => listEnabled().map((agentGroupId) => ({ agent_group_id: agentGroupId })),
    },
    enable: {
      access: 'approval',
      description: 'Enable the projected lifecycle for a group. Use --id <group-id>. Restart the group after.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        if (!getAgentGroup(id)) throw new Error(`group not found: ${id}`);
        setEnabled(id, true);
        return { agent_group_id: id, enabled: true };
      },
    },
    disable: {
      access: 'approval',
      description: 'Disable the projected lifecycle for a group, reverting to normal transcript resume.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        setEnabled(id, false);
        return { agent_group_id: id, enabled: false };
      },
    },
    status: {
      access: 'open',
      description: 'Check whether a group has the projected lifecycle enabled. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        return { agent_group_id: id, enabled: isEnabled(id) };
      },
    },
  },
});
