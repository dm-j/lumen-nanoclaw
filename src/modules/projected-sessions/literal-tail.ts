/**
 * Literal recent-turns tail for projected-lifecycle sessions. Read-only
 * host-side merge of `messages_in` + `messages_out` into plain text lines —
 * not the container's XML `<message>` format (a provider-facing convention
 * this never touches).
 *
 * Prefix-cache-aware anchored growth: a naive last-N sliding window shifts
 * its start point every turn, so the substituted text differs from byte
 * zero each time and Anthropic's longest-common-prefix cache matching gets
 * zero reuse across turns despite the calls being adjacent and mostly
 * identical. Instead the window's start point (the "anchor") is held fixed
 * across turns — each call is a strict superset of the previous call's tail
 * (append-only growth, N → N+1 → ... → 2N) — until the tail reaches 2×N,
 * at which point the anchor resets forward to the last N turns and the
 * cycle restarts. Validated as a real cost concern by a prior spike
 * (`docs/synthetic-context.md` in `~/Projects/nanoclaw`, "Planned:
 * prompt-cache-aware literal tail") — not a speculative addition.
 *
 * Compiler and responder run independent cycles with independent N
 * (`compileBriefing`'s COMPILER_TAIL_TURNS vs. `synthesize.ts`'s
 * RESPONDER_TAIL_TURNS) — anchor state per lane lives in `session_briefings`
 * (migration 025, this module's own table).
 *
 * The 2N turn-count trigger alone under-resets for a lane whose calls go
 * through Anthropic's server-side ephemeral prompt cache: a gap between
 * calls longer than the cache TTL already invalidates the cached prefix
 * regardless of where the anchor sits in its N→2N cycle, so the anchor keeps
 * growing through that gap and the eventual cache-miss rebuild pays full
 * price for a bigger tail than N ever required. The optional `cacheTtlMs`
 * param (migration 028's `*_last_call_at` columns) adds that second,
 * independent reset trigger for callers where it actually applies.
 *
 * Deliberately opt-in, not blanket-applied to every lane: the compiler lane
 * (`compileBriefing`) shells out to a fresh `claude -p --agent briefer`
 * process per call — a real Anthropic API call each time, so the ephemeral
 * cache TTL is a real constraint and this lane passes `cacheTtlMs`. The
 * responder lane (`synthesize.ts`, Lumen's own in-container session) instead
 * feeds a live provider session resume — a different caching path entirely,
 * not proven to share the same TTL behavior — so it omits `cacheTtlMs` and
 * keeps the original pure 2N-count reset until that's verified.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import { inboundDbPath, outboundDbPath, sessionDir } from '../../session-manager.js';
import { openInboundDb, openOutboundDb } from '../../db/session-db.js';
import { captionImage, isContentionError, isImageAttachment } from '../attachment-caption/caption.js';
import { resolveAssistantName, resolveGroupTimezone } from '../../container-config.js';
import { formatLocalIsoOffset } from '../../timezone.js';
import { getTailAnchor, setTailAnchor, type BriefingHistoryEntry, type TailLane } from './db.js';

interface TailRow {
  timestamp: string;
  sender: string;
  text: string;
}

// Hard bound on how much history a single anchor-growth cycle will ever read
// or hold, independent of N — protects a long-lived agent-shared session from
// an unbounded per-turn read once growth is in play.
const SAFETY_CAP = 500;

// Anthropic's default ephemeral prompt-cache TTL, for callers that opt into
// the `cacheTtlMs` reset trigger. Not configurable per call today (would
// need a 1h-cache beta header to raise it) — if that changes, this constant
// is the one place to update.
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatAttachmentsPlaceholder(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  return attachments
    .map((a) => {
      const name = a.name || a.filename || 'attachment';
      const type = a.type || 'file';
      const bracket = `[${type}: ${name}]`;
      if (typeof a.captionError === 'string' && a.captionError) {
        return `${bracket} (no description available yet — try again shortly)`;
      }
      if (typeof a.caption === 'string' && a.caption) {
        return `${bracket} ${a.caption}`;
      }
      if (typeof a.captionId === 'string' && a.captionId) {
        return `${bracket} (id: ${a.captionId} — description pending)`;
      }
      return bracket;
    })
    .join(' ');
}

/**
 * Renders a message's content as plain text for the literal tail. Text-only
 * (compiler/responder-lane) callers here never see raw attachment data — a
 * message with no `text` (e.g. a captionless photo) used to fall through to
 * the entire raw JSON content string, dumping the attachments array
 * (filenames, local paths) into the transcript as if it were chat text. That
 * breaks providers that expect a plain string, so attachments render as the
 * same bracketed placeholder the container's own XML formatter already uses
 * (formatAttachments in container/agent-runner/src/formatter.ts) instead.
 */
export function parseText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string; attachments?: unknown[] };
    return combineTextAndAttachments(parsed.text, parsed.attachments as any[] | undefined) ?? content;
  } catch {
    return content;
  }
}

/**
 * A user-supplied caption (`text`) and the attachment placeholder are both
 * kept — the caption alone says nothing about what's *in* the image, and
 * the placeholder alone drops what the user actually said. Matches
 * container/agent-runner/src/formatter.ts's formatSingleChat, which already
 * concatenates the two for the live agent's own view. Returns null only
 * when there's truly nothing to show (unrecognized content shape), so
 * callers can fall back to the raw JSON.
 */
export function combineTextAndAttachments(text: unknown, attachments: unknown[] | undefined): string | null {
  const placeholder = formatAttachmentsPlaceholder(attachments);
  if (typeof text === 'string' && text) {
    return placeholder ? `${text} ${placeholder}` : text;
  }
  return placeholder || null;
}

/**
 * Render one `[local-time+offset] Sender:\ntext` (or briefing) line as its
 * own markdown blockquote — every line of a multi-line entry gets the `> `
 * prefix so it stays one blockquote instead of breaking out of it, and an
 * empty line becomes a bare `>` rather than `> ` with invisible trailing
 * whitespace. Callers still join entries with a blank line between them, so
 * each renders as a visually distinct block instead of one merged quote.
 */
export function toQuoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

// Every open compile-briefing/renderLiteralTail cycle retries every
// not-yet-captioned legacy attachment (see resolveInboundText below) — with
// no cap, a genuinely broken caption endpoint gets hammered once per
// attachment on every cycle (observed in practice: dozens of calls in
// minutes against a handful of images). Capped after this many attempts;
// the placeholder still reads the last captionError, it just stops retrying.
// Contention (the shared Ollama daemon busy with the agent's own turn, not a
// broken model — see isContentionError) gets a more forgiving cap: each
// attempt here is already naturally spaced by the render cadence (minutes
// apart), so no in-process backoff is needed, just a longer leash before
// giving up.
const MAX_LAZY_CAPTION_ATTEMPTS = 3;
const MAX_LAZY_CAPTION_ATTEMPTS_CONTENTION = 8;

/**
 * Resolves an inbound row's plain text, lazily captioning + persisting any
 * image attachment that predates the captioning feature (has a staged
 * `localPath` but neither `caption` nor `captionError` yet — e.g. a message
 * stored before this feature existed). Persisted via the same read-write
 * `db` handle the caller already has open, before it closes — inbound.db is
 * the host's own DB (sole writer), unlike outbound.db which the host only
 * ever reads, so this lazy path is inbound-only.
 */
async function resolveInboundText(
  db: Database.Database,
  agentGroupId: string,
  sessionId: string,
  id: string,
  content: string,
): Promise<string> {
  let parsed: { text?: string; attachments?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const attachments = parsed.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return combineTextAndAttachments(parsed.text, attachments) ?? content;
  }

  let changed = false;
  for (const att of attachments) {
    // Skip only once a caption has actually landed — a captionError alone
    // (e.g. a transient network blip, observed in practice against a cloud
    // Ollama model) must not permanently block retries on later renders,
    // up to MAX_LAZY_CAPTION_ATTEMPTS.
    if (att.caption) continue;
    if (typeof att.localPath !== 'string' || !isImageAttachment(att)) continue;
    // A captionId means this attachment is owned by the async job triggered
    // at ingest (session-manager.ts's triggerCaptioning) — recaptioning it
    // here too would race that job and double the model calls. This lazy
    // path exists only to backfill attachments stamped before the async
    // notify flow existed, which never got a captionId at all.
    if (typeof att.captionId === 'string' && att.captionId) continue;
    const attempts = typeof att.captionAttempts === 'number' ? att.captionAttempts : 0;
    const priorErrorWasContention = typeof att.captionError === 'string' && isContentionError(att.captionError);
    const cap = priorErrorWasContention ? MAX_LAZY_CAPTION_ATTEMPTS_CONTENTION : MAX_LAZY_CAPTION_ATTEMPTS;
    if (attempts >= cap) continue;

    try {
      const filePath = path.join(sessionDir(agentGroupId, sessionId), att.localPath);
      const bytes = fs.readFileSync(filePath);
      const result = await captionImage(bytes.toString('base64'), parsed.text || undefined);
      if (result.ok) {
        att.caption = result.text;
        delete att.captionError;
        delete att.captionAttempts;
      } else {
        att.captionError = result.text;
        att.captionAttempts = attempts + 1;
      }
    } catch (err) {
      att.captionError = err instanceof Error ? err.message : String(err);
      att.captionAttempts = attempts + 1;
    }
    changed = true;
  }

  if (changed) {
    db.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(parsed), id);
  }

  return combineTextAndAttachments(parsed.text, attachments) ?? content;
}

async function readAllTurns(agentGroupId: string, sessionId: string): Promise<TailRow[]> {
  const inPath = inboundDbPath(agentGroupId, sessionId);
  const outPath = outboundDbPath(agentGroupId, sessionId);

  const rows: TailRow[] = [];

  if (fs.existsSync(inPath)) {
    const db = openInboundDb(inPath);
    try {
      const inRows = db
        .prepare(
          // status = 'completed' only — a still-pending/staged row is the
          // in-flight batch, already shown separately as "## New message"
          // (readPendingBatchText in db.ts). Without this filter, a message
          // not yet marked completed by the time this tail renders shows up
          // twice in the same prompt: once here as "already-handled
          // history", once in the new-message section as "brand-new" — a
          // contradiction that plausibly reads to the model as "nothing new
          // to add" even when the rest of the batch genuinely is.
          `SELECT id, timestamp, content FROM messages_in WHERE kind IN ('chat','chat-sdk') AND status = 'completed' ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(SAFETY_CAP) as Array<{ id: string; timestamp: string; content: string }>;
      for (const r of inRows) {
        let sender = 'user';
        try {
          const parsed = JSON.parse(r.content) as { sender?: string };
          sender = parsed.sender ?? 'user';
        } catch {
          // keep default
        }
        const text = await resolveInboundText(db, agentGroupId, sessionId, r.id, r.content);
        rows.push({ timestamp: r.timestamp, sender, text });
      }
    } finally {
      db.close();
    }
  }

  if (fs.existsSync(outPath)) {
    const db = openOutboundDb(outPath);
    try {
      const outRows = db
        .prepare(`SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY timestamp DESC LIMIT ?`)
        .all(SAFETY_CAP) as Array<{ timestamp: string; content: string }>;
      // The agent's configured display name, not a hardcoded role label —
      // same resolution delivery.ts already uses for the vault transcript
      // export (assistant_name override → group name → "Assistant").
      const assistantName = resolveAssistantName(agentGroupId);
      for (const r of outRows) {
        rows.push({ timestamp: r.timestamp, sender: assistantName, text: parseText(r.content) });
      }
    } finally {
      db.close();
    }
  }

  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return rows.slice(-SAFETY_CAP);
}

export async function renderLiteralTail(
  agentGroupId: string,
  sessionId: string,
  sessionKey: string,
  lane: TailLane,
  n: number,
  briefingHistory?: BriefingHistoryEntry[],
  cacheTtlMs?: number,
): Promise<string> {
  const all = await readAllTurns(agentGroupId, sessionId);

  // Interleaved by timestamp with the turns below, not clumped into one
  // leading block — a briefing summarizes the turns before it and gets
  // superseded by the turns after it, so showing all N past briefings
  // before any turns (the old behavior) presented them out of order: e.g.
  // a briefing compiled *during* this very turn window would appear to
  // precede turns that actually came first. Interleaving still never
  // touches `selected`, the anchor, or the N-turn budget below — those stay
  // turn-only, so growth/reset/cache-prefix behavior is unchanged; this
  // only affects final rendering.
  const briefingEntries = briefingHistory ?? [];

  if (all.length === 0 && briefingEntries.length === 0) return '';

  const anchor = getTailAnchor(sessionKey, lane);

  const cacheStale =
    cacheTtlMs !== undefined && anchor.lastCallAt !== null && Date.now() - Date.parse(anchor.lastCallAt) > cacheTtlMs;

  let selected: TailRow[];
  const needsReset = anchor.anchorTs === null || anchor.count >= 2 * n || cacheStale;

  selected = needsReset ? [] : all.filter((r) => r.timestamp >= anchor.anchorTs!);

  // Anchor missing, past its 2N cap, cache-stale (see CACHE_TTL_MS above), or
  // aged out of SAFETY_CAP (filter came back empty) — reset to the last N
  // turns, fresh cycle.
  if (selected.length === 0 && all.length > 0) {
    selected = all.slice(-n);
  }

  const newAnchorTs = selected[0]?.timestamp ?? null;
  setTailAnchor(sessionKey, lane, newAnchorTs, selected.length);

  // Local time + explicit numeric offset, not raw UTC — tells the model
  // what time it should think "now" is, while staying trivially convertible
  // back to UTC if needed. Sort key stays the raw UTC ISO timestamp (still
  // lexicographically ordered); only the rendered text changes.
  const tz = resolveGroupTimezone(agentGroupId);
  interface RenderEntry {
    timestamp: string;
    text: string;
  }
  const entries: RenderEntry[] = [
    ...selected.map((r) => ({
      timestamp: r.timestamp,
      text: `[${formatLocalIsoOffset(r.timestamp, tz)}] ${r.sender}:\n${r.text}`,
    })),
    ...briefingEntries.map((b) => ({
      timestamp: b.createdAt,
      text: `[${formatLocalIsoOffset(b.createdAt, tz)}] Briefing subagent:\n${b.content}`,
    })),
  ];
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return entries.map((e) => toQuoteBlock(e.text)).join('\n\n');
}
