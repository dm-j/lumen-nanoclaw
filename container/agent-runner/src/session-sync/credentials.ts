/**
 * Reads the per-session sync credentials file the host writes at spawn time
 * (src/session-sync/session-credentials.ts on the host side) — deliberately
 * separate from container.json (group-scoped, shared across sibling
 * sessions) since these are session-scoped. Lands at /workspace/.session-sync.json
 * because the whole session directory is bind-mounted at /workspace.
 */
import fs from 'fs';

const DEFAULT_CREDENTIALS_PATH = '/workspace/.session-sync.json';

export interface SessionSyncCredentials {
  url: string;
  token: string;
  pinnedCertPem: string;
}

/**
 * Returns null if the file is absent (transport isn't 'sync' for this group)
 * or unreadable. `path` is overridable for tests — real callers always use
 * the default, since /workspace is where the host actually mounts it.
 */
export function loadSessionSyncCredentials(path: string = DEFAULT_CREDENTIALS_PATH): SessionSyncCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Partial<SessionSyncCredentials>;
    if (typeof raw.url !== 'string' || typeof raw.token !== 'string' || typeof raw.pinnedCertPem !== 'string') {
      return null;
    }
    return { url: raw.url, token: raw.token, pinnedCertPem: raw.pinnedCertPem };
  } catch {
    return null;
  }
}
