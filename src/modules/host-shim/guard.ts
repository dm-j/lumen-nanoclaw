/**
 * Host-shim guard adapter — the module's single catalog entry.
 *
 * This action can never hold or deny at the guard layer: the security
 * boundary is the per-agent-group whitelist-directory check in ./exec.ts
 * (does a `<name>-host` script exist in *this group's own* directory?) plus
 * whatever validation that script does itself. Per-call human approval would
 * make routine tool use unusably slow. Cross-group segregation is enforced
 * structurally by `resolveHostShimsDir` keying off the calling session's
 * `agent_group_id` — there is no path from one group's request to another
 * group's whitelist directory.
 */
import { ALLOW, defineGuardedAction } from '../../guard/index.js';

export const hostShimExec = defineGuardedAction({
  action: 'host_shim.exec',
  decide: () =>
    ALLOW('host-shim whitelist is per-agent-group and filesystem-based; each -host script validates its own args'),
});
