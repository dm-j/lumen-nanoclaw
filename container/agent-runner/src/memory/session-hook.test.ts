import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK, memoryContextForSessionStart, type MemorySessionStartSource } from './session-hook.js';

describe('memory SessionStart contract', () => {
  it('injects startup, clear, and compact but not resume', () => {
    expect(MEMORY_SESSION_HOOK).toMatchObject({
      command: 'bun /app/src/memory/hook.ts',
      legacyCommands: ['bun /app/src/memory-hook.ts'],
      sources: ['startup', 'clear', 'compact'],
    });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-contract-'));
    try {
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), '# Memory Index\n');
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), '# Definition\n');
      const expected: Record<MemorySessionStartSource, boolean> = {
        startup: true,
        resume: false,
        clear: true,
        compact: true,
      };
      for (const [source, shouldInject] of Object.entries(expected)) {
        expect(Boolean(memoryContextForSessionStart(source as MemorySessionStartSource, base))).toBe(shouldInject);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('skips injection for projected sessions even on startup/clear/compact', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-projected-'));
    try {
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), '# Memory Index\n');
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), '# Definition\n');
      for (const source of ['startup', 'clear', 'compact'] as const) {
        expect(memoryContextForSessionStart(source, base, true)).toBeUndefined();
      }
      // Non-projected callers are unaffected by the new parameter's default.
      expect(memoryContextForSessionStart('startup', base)).toBeTruthy();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
