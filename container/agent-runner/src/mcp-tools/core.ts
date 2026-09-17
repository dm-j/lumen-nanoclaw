/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * Look up the explicitly named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  // Defensive: an agent replying to an a2a message might copy the rendered
  // `sender="X (Agent)"` display name into `to` instead of the actual
  // destination name — strip the suffix, then fall back to a case-insensitive
  // match against known destination names (local_name is normally lowercase;
  // the display name in `sender` isn't).
  const normalizedTo = to.endsWith(' (Agent)') ? to.slice(0, -' (Agent)'.length) : to;
  const dest =
    findByName(normalizedTo) ??
    findByName(to) ??
    getAllDestinations().find((d) => d.name.toLowerCase() === normalizedTo.toLowerCase());
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1").',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

/**
 * Shared write for both noReply-flagged tools below. Marks the outbound
 * content `noReply: true`, which the receiving agent's formatter renders
 * distinctly (see formatter.ts) so the model on the other end doesn't feel
 * obligated to reply to a reply. Backstops the "don't acknowledge an
 * acknowledgment" standing instruction in container/CLAUDE.md with
 * something structural, not just prompt discipline — real acknowledgment
 * loops were observed in practice (2026-09-16).
 */
function sendNoReply(to: string, text: string, toolName: string, closesSession: boolean) {
  const routing = resolveRouting(to);
  if ('error' in routing) return err(routing.error);

  const id = generateId();
  const seq = writeMessageOut({
    id,
    in_reply_to: getCurrentInReplyTo(),
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    // closesSession only on report_completion — tells the host to close
    // *this* (the caller's own) session once delivered, so a stray later
    // message can't resurrect it. See agent-route.ts's handling of a
    // closed target session (bounces plain send_message, no-ops noReply
    // traffic) and its resulting closure of the sender's session.
    content: JSON.stringify({ text, noReply: true, ...(closesSession ? { closesSession: true } : {}) }),
  });

  log(`${toolName}: #${seq} → ${routing.resolvedName}`);
  return ok(`Sent to ${routing.resolvedName} (id: ${seq})`);
}

/**
 * Closes out an a2a exchange from the coordinator's side — "the other
 * agent just told me it's done, and I have nothing further to add."
 */
export const acknowledgeCompletion: McpToolDefinition = {
  tool: {
    name: 'acknowledge_completion',
    description:
      "Use to close out another agent's completion report without triggering a further reply. Not for replying to David — use send_message for that.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name of the agent whose completion you are acknowledging.',
        },
        note: { type: 'string', description: 'Optional short note. Defaults to a plain acknowledgment.' },
      },
      required: ['to'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const note = (args.note as string) || 'Acknowledged.';
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    return sendNoReply(to, note, 'acknowledge_completion', false);
  },
};

/**
 * Closes out an a2a exchange from the worker's side — the counterpart to
 * acknowledgeCompletion. Delegated work orders end with a mandatory final
 * reply; sending that reply through this tool instead of plain
 * send_message means the coordinator sees it's the end of the line and
 * doesn't reply back, cutting an ack loop off one hop earlier than relying
 * on the coordinator to call acknowledge_completion itself.
 */
export const reportCompletion: McpToolDefinition = {
  tool: {
    name: 'report_completion',
    description:
      "Use for your final reply after finishing delegated work — reports the result and signals there's nothing further to discuss. Not for mid-task updates or questions — use send_message for those.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name of the agent that delegated this work to you.',
        },
        text: { type: 'string', description: 'The result or outcome to report.' },
        status: {
          type: 'string',
          enum: ['SUCCESS', 'FAILURE'],
          description: 'Outcome of the delegated work. Defaults to SUCCESS.',
        },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    const status = (args.status as string) || 'SUCCESS';
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');
    if (status !== 'SUCCESS' && status !== 'FAILURE') return err('status must be SUCCESS or FAILURE');
    return sendNoReply(to, `${status}: ${text}`, 'report_completion', true);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['to', 'path'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const filePath = args.path as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!filePath) return err('path is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, acknowledgeCompletion, reportCompletion, sendFile, editMessage, addReaction]);
