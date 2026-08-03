/**
 * remember / recall MCP tools — ad-hoc vault fact capture and retrieval.
 *
 * The container has no vault filesystem access (only the host-side
 * projected-sessions/vault-transcript modules do), so both tools shell out
 * to the container's own `host-shim` CLI — the same transport an agent
 * already gets from its Bash tool (`host-shim <name> [args]`), talking to
 * this group's `remember-host` / `recall-host` scripts in its host-shim
 * whitelist folder (see docs/host-shims.md, add-host-scripts skill). Not
 * every group will have these scripts — a group without them just gets a
 * clean "no whitelisted shim" error via host-shim's own refusal path.
 */
import { execFile } from 'node:child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

// recall/remember dispatch a `claude -p --agent <x>` subagent call on the
// host (recall-host/remember-host), which per compile-briefing.ts's own
// documented range runs 20-90s in production. Layered above the container's
// own host-shim CLI poll deadline (cli/host-shim.ts, 210s), which is itself
// above the host's execHostShim ceiling for these names (host-shim/exec.ts's
// timeoutFor, 180s) — each wrapper needs enough margin to let the layer
// inside it report its own clean timeout instead of being killed mid-write.
const HOST_SHIM_TIMEOUT_MS = 220_000;
const MAX_BUFFER = 1024 * 1024;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function runHostShim(name: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'host-shim',
      [name, ...args],
      { timeout: HOST_SHIM_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const CONFIDENCE_VALUES = ['certain', 'uncertain', 'doubtful', 'speculative'] as const;
const DETAIL_LEVELS = ['sentence', 'paragraph', 'bullets', 'note'] as const;

export const remember: McpToolDefinition = {
  tool: {
    name: 'remember',
    description:
      'Record a fact into the vault (filed to 00-Inbox for later triage). Use this to save something worth remembering — from a conversation or your own initiative — so it can be recalled in a future turn. Every fact requires a title, its content, where it came from, and how confident you are in it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short note title (also becomes the filename)' },
        content: { type: 'string', description: 'The fact itself, in your own words' },
        source: {
          type: 'string',
          description: 'Where this came from, e.g. "Conversation with David", "Own inference"',
        },
        confidence: {
          type: 'string',
          enum: [...CONFIDENCE_VALUES],
          description: 'How sure you are of this fact',
        },
        extra: {
          type: 'object',
          description:
            'Any additional frontmatter key/value pairs worth recording (e.g. tags, valid-from, importance). Optional.',
          additionalProperties: true,
        },
      },
      required: ['title', 'content', 'source', 'confidence'],
    },
  },
  async handler(args) {
    const title = (args.title as string) || '';
    const content = (args.content as string) || '';
    const source = (args.source as string) || '';
    const confidence = (args.confidence as string) || '';
    const extra = (args.extra as Record<string, unknown>) || {};

    if (!title || !content || !source || !confidence) {
      return err('title, content, source, and confidence are all required');
    }
    if (!(CONFIDENCE_VALUES as readonly string[]).includes(confidence)) {
      return err(`confidence must be one of: ${CONFIDENCE_VALUES.join(', ')}`);
    }

    // Required fields always win over anything with the same key in extra.
    const payload = JSON.stringify({ ...extra, title, content, source, confidence });
    const { code, stdout, stderr } = await runHostShim('remember', [payload]);
    if (code !== 0) return err(stderr.trim() || `remember-host exited ${code}`);
    return ok(stdout.trim() || 'Fact recorded.');
  },
};

export const recall: McpToolDefinition = {
  tool: {
    name: 'recall',
    description:
      'Ask a question and get an answer synthesized from the vault (and optionally the web), with confidence tags and wikilink citations. Not a plain keyword search — this dispatches the vault\'s "seeker" subagent to actually research and answer the question.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The question to answer' },
        ask_as: {
          type: 'string',
          description:
            'Whose perspective the question is asked from — changes pronoun resolution (e.g. ask_as "David" for "what is my birthday" meaning David\'s birthday). Defaults to "Lumen".',
        },
        detail: {
          type: 'string',
          enum: [...DETAIL_LEVELS],
          description:
            'How much detail to return. "sentence"/"paragraph"/"bullets" return the answer inline. "note" instead files a full standalone note to the vault inbox and returns its path for you to read.',
        },
        research: {
          type: 'boolean',
          description: 'Allow the web to be searched in addition to the vault, when the vault alone is insufficient.',
        },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = (args.query as string) || '';
    if (!query) return err('query is required');
    const askAs = (args.ask_as as string) || 'Lumen';
    const detail = (args.detail as string) || 'paragraph';
    if (!(DETAIL_LEVELS as readonly string[]).includes(detail)) {
      return err(`detail must be one of: ${DETAIL_LEVELS.join(', ')}`);
    }
    const research = args.research === true;

    const payload = JSON.stringify({ query, ask_as: askAs, detail, research });
    const { code, stdout, stderr } = await runHostShim('recall', [payload]);
    if (code !== 0) return err(stderr.trim() || `recall-host exited ${code}`);
    return ok(stdout.trim() || 'No answer found.');
  },
};

registerTools([remember, recall]);
