/**
 * Per-session sync connection credentials, written alongside a session's own
 * DB files — deliberately NOT part of container.json (materializeContainerJson
 * writes one shared file per AGENT GROUP, RO-bind-mounted into every
 * container spawned for that group; a session-scoped token there would be
 * silently overwritten by a sibling session's spawn under any isolation mode
 * that allows concurrent sessions in one group). This file lives in the
 * session's own directory instead, which is never shared across sessions.
 *
 * Purely additive: only written when the agent group's container_config has
 * transport: 'sync' (see docs/session-sync-transport.md §6) — every group
 * still on the default 'file' transport is completely unaffected, and no
 * mount or read/write path changes as a result of this file existing.
 */
import fs from 'fs';
import path from 'path';

import { SESSION_SYNC_PORT } from '../config.js';
import { getContainerConfig } from '../db/container-configs.js';
import { sessionDir } from '../session-manager.js';
import { getInstallCert } from './cert.js';
import { getInstallSecret } from './secret.js';
import { SESSION_SYNC_TOKEN_TTL_MS, signToken } from './transport.js';

export interface SessionSyncCredentials {
  url: string;
  token: string;
  pinnedCertPem: string;
}

const CREDENTIALS_FILENAME = '.session-sync.json';

function credentialsPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), CREDENTIALS_FILENAME);
}

/**
 * Writes (or removes) the session's sync credentials file to match its
 * agent group's current transport setting. Called at spawn time — same
 * "regenerate fresh on every spawn" pattern as materializeContainerJson —
 * so a group flipped back to 'file' doesn't leave a stale, still-valid
 * token file behind for a container that will never read it.
 *
 * `host` is the address the container should use to reach this host process
 * — resolution of that address (host.docker.internal vs. a Linux gateway IP)
 * is the caller's concern (container-runner.ts already has this logic for
 * other host-reachable services); this function just formats the URL.
 */
export function writeSessionSyncCredentials(agentGroupId: string, sessionId: string, host: string): void {
  const p = credentialsPath(agentGroupId, sessionId);
  const config = getContainerConfig(agentGroupId);

  if (config?.transport !== 'sync') {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }

  const credentials: SessionSyncCredentials = {
    url: `wss://${host}:${SESSION_SYNC_PORT}`,
    token: signToken(sessionId, getInstallSecret(), SESSION_SYNC_TOKEN_TTL_MS),
    pinnedCertPem: getInstallCert().cert,
  };
  fs.writeFileSync(p, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
}
