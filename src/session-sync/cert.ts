/**
 * Self-signed TLS cert for the session-sync wss:// server. Same-box today
 * (see docs/session-sync-transport.md §4) — a self-signed cert is fine
 * because the container pins the install's own cert, it doesn't validate
 * against a public CA.
 *
 * Generated once via the system `openssl` binary (native platform tool —
 * no cert-generation library added for this), cached at
 * data/session-sync/{cert,key}.pem.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

const CERT_DIR = path.join(DATA_DIR, 'session-sync');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');

export interface TlsMaterial {
  cert: string;
  key: string;
}

export function getInstallCert(): TlsMaterial {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return { cert: fs.readFileSync(CERT_PATH, 'utf8'), key: fs.readFileSync(KEY_PATH, 'utf8') };
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    KEY_PATH,
    '-out',
    CERT_PATH,
    '-days',
    '3650',
    '-subj',
    '/CN=nanoclaw-session-sync',
    // Required, not cosmetic: Node/Bun's TLS client checks the peer cert's
    // SAN against the connection hostname even when `ca` is pinned
    // explicitly — a cert with no SAN fails every connection outright.
    // host.docker.internal is the address container-runner.ts actually
    // hands the container (session-credentials.ts) — omitting it fails the
    // handshake with an opaque ErrorEvent, only visible once something
    // actually connects through Docker's network instead of loopback.
    '-addext',
    'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1',
  ]);
  fs.chmodSync(KEY_PATH, 0o600);
  return { cert: fs.readFileSync(CERT_PATH, 'utf8'), key: fs.readFileSync(KEY_PATH, 'utf8') };
}
