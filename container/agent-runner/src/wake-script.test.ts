import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(JSON.stringify({ sender: 'Alice', text: 'hello' }));
});

afterEach(() => {
  closeSessionDb();
});

/** Run the loop until the first reply lands; return the prompt the model was given. */
async function firstPrompt(wakeScript?: string): Promise<string> {
  const prompts: string[] = [];
  const provider = new MockProvider({}, (prompt) => {
    prompts.push(prompt);
    return '<message to="discord-test">ok</message>';
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal, wakeScript });
  const start = Date.now();
  while (getUndeliveredMessages().length === 0) {
    if (Date.now() - start > 3000) throw new Error('timeout waiting for reply');
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  void loop.catch(() => {}); // the loop only unwinds on its next poll tick; the integration tests don't await it either
  return prompts[0];
}

describe('wake script', () => {
  it('renders the script data ahead of the messages as <wake-context>', async () => {
    const prompt = await firstPrompt(`echo '{"wakeAgent": true, "data": "PINNED: buy milk"}'`);
    expect(prompt.startsWith('<wake-context>\nPINNED: buy milk\n</wake-context>\n\n')).toBe(true);
    expect(prompt).toContain('hello');
  });

  it('adds nothing when no wake script is configured', async () => {
    expect(await firstPrompt()).not.toContain('<wake-context>');
  });

  it('adds nothing when the script fails', async () => {
    expect(await firstPrompt('exit 1')).not.toContain('<wake-context>');
  });
});
