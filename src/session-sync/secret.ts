/**
 * Per-install HMAC secret for session-sync connection tokens.
 * Generated once, cached at data/session-sync/secret (0600). Never logged.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

const SECRET_PATH = path.join(DATA_DIR, 'session-sync', 'secret');

export function getInstallSecret(): string {
  if (fs.existsSync(SECRET_PATH)) {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  }
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}
