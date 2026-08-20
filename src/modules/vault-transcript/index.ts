/**
 * vault-transcript module.
 *
 * Opt-in per agent group: an agent group with a row in
 * `vault_transcript_enabled` gets its turns exported live to
 * `07-Daily/Transcripts-readonly/` via `transcript-append-host`. Absence =
 * `appendTranscriptTurn` (transcript.ts) returns before ever touching
 * execHostShim.
 *
 * Fully self-contained: own migration (030), own table, own CLI resource
 * (`ncl vault-transcript enable|disable|list`) — no reach-in to
 * `container_configs`. Runtime call sites (container-runner.ts,
 * delivery.ts) dynamic-import this file for `appendPendingInboundTurns` /
 * `appendDeliveredOutboundTurn` / `appendCaptionedAttachment`.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerResource } from '../../cli/crud.js';
import { isEnabled, listEnabled, setEnabled } from './db.js';

export { appendPendingInboundTurns, appendDeliveredOutboundTurn, appendCaptionedAttachment } from './transcript.js';

registerResource({
  name: 'vault-transcript',
  plural: 'vault-transcripts',
  table: 'vault_transcript_enabled',
  description:
    'Opt-in per-agent-group live transcript export: enabled groups get every turn appended to their vault via ' +
    'transcript-append-host. Requires this group to have a configured `transcript-append-host` script (VAULT_PATH ' +
    'set) in its host-shim whitelist folder — see /add-vault-memory-pipeline.',
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
      description: 'List agent groups with vault transcript export enabled.',
      handler: async () => listEnabled().map((agentGroupId) => ({ agent_group_id: agentGroupId })),
    },
    enable: {
      access: 'approval',
      description: 'Enable live vault transcript export for a group. Use --id <group-id>.',
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
      description: 'Disable live vault transcript export for a group.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        setEnabled(id, false);
        return { agent_group_id: id, enabled: false };
      },
    },
    status: {
      access: 'open',
      description: 'Check whether a group has vault transcript export enabled. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        return { agent_group_id: id, enabled: isEnabled(id) };
      },
    },
  },
});
