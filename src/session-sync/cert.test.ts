import { execFileSync } from 'child_process';

import { describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), `nanoclaw-session-sync-cert-${Date.now()}`) };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { getInstallCert } = await import('./cert.js');

describe('getInstallCert', () => {
  it('includes host.docker.internal in the SAN — the actual hostname containers connect through (not just loopback)', () => {
    const { cert } = getInstallCert();
    const text = execFileSync('openssl', ['x509', '-noout', '-text'], { input: cert }).toString();
    const sanLine = text.split('\n').find((line) => line.includes('Subject Alternative Name'));
    const sanValues = text
      .split('\n')
      [text.split('\n').findIndex((line) => line.includes('Subject Alternative Name')) + 1]?.trim();

    expect(sanLine).toBeDefined();
    expect(sanValues).toContain('DNS:host.docker.internal');
  });
});
