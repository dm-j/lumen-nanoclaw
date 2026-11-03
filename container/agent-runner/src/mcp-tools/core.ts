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
    // closesSession (report_completion only) tells the host to close *this*
    // session once delivered — safe now because a task session created by
    // assign_task is guaranteed dedicated to one work order (has a
    // parent_session_id); the host re-checks that before actually closing
    // anything, this flag alone can't close a shared session. See
    // agent-route.ts's parent_session_id gate.
    content: JSON.stringify({ text, noReply: true, ...(closesSession ? { closesSession: true } : {}) }),
  });

  log(`${toolName}: #${seq} → ${routing.resolvedName}`);
  return ok(`Sent to ${routing.resolvedName} (id: ${seq})`);
}

/**
 * Validate and copy files into this message's outbox dir, returning the
 * filenames to put in the message's `files`. All-or-nothing: every path is
 * checked before any copy, so a typo in the second path doesn't leave a
 * half-sent message. Files from different folders can share a basename (every
 * inbox photo is `attachment-<n>.jpg`); a clash gets an index prefix rather
 * than an overwrite. `displayName` only applies to a single file.
 */
function stageOutboxFiles(id: string, requested: string[], displayName?: string): { filenames: string[] } | { error: string } {
  const resolved = requested.map((p) => (path.isAbsolute(p) ? p : path.resolve('/workspace/agent', p)));
  const missing = requested.filter((_, i) => !fs.existsSync(resolved[i]));
  if (missing.length > 0) return { error: `File not found: ${missing.join(', ')}` };

  const outboxDir = path.join(process.env.NANOCLAW_OUTBOX_DIR || '/workspace/outbox', id); // env override: tests have no /workspace
  fs.mkdirSync(outboxDir, { recursive: true });
  const filenames: string[] = [];
  resolved.forEach((src, i) => {
    let name = resolved.length === 1 && displayName ? displayName : path.basename(src);
    if (filenames.includes(name)) name = `${i + 1}-${name}`;
    filenames.push(name);
    fs.copyFileSync(src, path.join(outboxDir, name));
  });
  return { filenames };
}

const PATHS_PROPERTY = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Several file paths to deliver together in ONE message (use this, not repeated calls, when the receiver must see the files side by side, e.g. images to compare).',
};

/**
 * Delegates work — or a question another agent is better placed to answer,
 * by domain, data, or tool access — to a brand-new, dedicated session, not
 * the target's usual shared a2a session. Questions and answers within that
 * one delegation still route normally (the existing reply-chain/
 * source_session_id mechanism in agent-route.ts already handles that); what
 * assign_task changes is that the *first* message starts a session scoped
 * to exactly this one work order, so its eventual report_completion can
 * safely close only that session — never the target's ongoing traffic with
 * anyone else. Doesn't bypass the normal a2a guard (destination ACL,
 * approval gates) — same checks as send_message, just a different session
 * target. See docs/roadmap/task-id-routing-spike.md.
 */
export const assignTask: McpToolDefinition = {
  tool: {
    name: 'assign_task',
    description:
      'Delegate work, or ask a question only another agent can answer (its domain, its data, or a tool it has and you don\'t) — in a fresh, dedicated session for just this. Use instead of send_message when starting something new. Usual contact rules apply (destination permissions, approval gates) — this only changes which session the message lands in.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name of the agent to delegate to.',
        },
        task: { type: 'string', description: 'The work order — what you need done.' },
        paths: PATHS_PROPERTY,
      },
      required: ['to', 'task'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const task = args.task as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!task) return err('task is required');

    const dest = findByName(to);
    if (dest?.type === 'channel') return err(`"${to}" is a channel, not an agent — assign_task only targets agents.`);

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const id = generateId();
    let files: string[] = [];
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      const staged = stageOutboxFiles(id, args.paths as string[]);
      if ('error' in staged) return err(staged.error);
      files = staged.filenames;
    }
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: task, assignTaskId: taskId, ...(files.length ? { files } : {}) }),
    });

    log(`assign_task: #${seq} → ${routing.resolvedName} (task ${taskId})`);
    return ok(`Task assigned to ${routing.resolvedName} in a new session (id: ${seq})`);
  },
};

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
    description: 'Send one or more files to a named destination in a single message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        paths: PATHS_PROPERTY,
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (single file only; default: basename of path)' },
      },
      required: ['to'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const requested = Array.isArray(args.paths) ? (args.paths as string[]) : args.path ? [args.path as string] : [];
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (requested.length === 0) return err('path (or paths) is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    // All-or-nothing: check every file before copying any, so a typo in the
    // second path doesn't leave a half-sent message.
    const id = generateId();
    const staged = stageOutboxFiles(id, requested, args.filename as string | undefined);
    if ('error' in staged) return err(staged.error);
    const { filenames } = staged;

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: filenames }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filenames.join(', ')})`);
    return ok(`${filenames.length} file(s) sent to ${routing.resolvedName} (id: ${id}, filenames: ${filenames.join(', ')})`);
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

registerTools([sendMessage, assignTask, acknowledgeCompletion, reportCompletion, sendFile, editMessage, addReaction]);
