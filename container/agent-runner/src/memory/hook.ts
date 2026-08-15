import fs from 'fs';

import { MEMORY_SESSION_HOOK, memoryContextForSessionStart, type MemorySessionStartSource } from './session-hook.js';

function readSource(): MemorySessionStartSource | undefined {
  try {
    const input: unknown = JSON.parse(fs.readFileSync(0, 'utf-8'));
    if (!input || typeof input !== 'object' || !('source' in input)) return undefined;
    const source = input.source;
    const validSources: readonly unknown[] = [...MEMORY_SESSION_HOOK.sources, 'resume'];
    if (validSources.includes(source)) {
      return source as MemorySessionStartSource;
    }
  } catch {
    // Invalid hook input fails closed: no additional context is emitted.
  }
  return undefined;
}

// Same marker convention as projected-sessions.ts's isProjectedSession()
// (container/agent-runner/src/projected-sessions.ts), duplicated rather than
// imported to keep this hook script standalone/dependency-free — see the
// DECISION comment on memoryContextForSessionStart for why this matters.
const baseDir = process.argv[2];
const isProjected = fs.existsSync(`${baseDir ?? '/workspace/agent'}/.projected-sessions-enabled`);

const source = readSource();
const context = source ? memoryContextForSessionStart(source, baseDir, isProjected) : undefined;
if (context) console.log(context);
