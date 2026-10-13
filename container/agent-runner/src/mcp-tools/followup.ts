/**
 * set_followup / clear_followup — a self-cancelling check-in timer.
 *
 * Opt-in per agent group (`container_configs.followup_enabled` → container.json
 * `followup`); groups without it never see these tools. Fire-and-forget system
 * actions handled by src/modules/followup/ on the host, which cancels the timer
 * itself when a real user message arrives.
 */
import { loadConfig } from '../config.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function send(payload: Record<string, unknown>): void {
  writeMessageOut({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    content: JSON.stringify(payload),
  });
}

const setFollowup: McpToolDefinition = {
  tool: {
    name: 'set_followup',
    description:
      'Sets an internal reminder to come back to this to give yourself the *option* to continue the conversation or act on your own initiative.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        minutes: {
          type: 'number',
          description:
            'Minutes from now (1–1440). Fires only if the user stays silent: a new user message cancels it automatically, and setting another replaces it.',
        },
        note: { type: 'string', description: 'Optional note to self, shown to you when the timer fires.' },
      },
      required: ['minutes'],
    },
  },
  async handler(args) {
    const minutes = Number(args.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return err('minutes must be between 1 and 1440');
    send({ action: 'set_followup', minutes, note: typeof args.note === 'string' ? args.note : '' });
    return ok(`Follow-up set for ${minutes} min. It is cancelled if the user messages first.`);
  },
};

const clearFollowup: McpToolDefinition = {
  tool: {
    name: 'clear_followup',
    description: 'Cancel your pending follow-up timer, if any.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    send({ action: 'clear_followup' });
    return ok('Follow-up cancelled.');
  },
};

if (loadConfig().followup) registerTools([setFollowup, clearFollowup]);
