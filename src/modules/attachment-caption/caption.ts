/**
 * Captions image attachments via a local Ollama vision model.
 *
 * Two-phase: `stampCaptionIds` runs synchronously and instantly at ingest —
 * before extractAttachmentFiles (session-manager.ts) strips the base64
 * `data` field — assigning each image attachment a short, stable
 * `captionId` so a placeholder can reference it before captioning has even
 * started. The actual model call happens afterwards, off the delivery path
 * (triggered from session-manager.ts's `triggerCaptioning`, which owns
 * disk/DB access this module can't reach without an import cycle).
 *
 * The caption rides along in the attachment's own JSON (`caption` on
 * success, `captionError` on failure) so every downstream renderer picks it
 * up: container/agent-runner/src/formatter.ts's formatAttachments (the live
 * agent's own XML view) and literal-tail.ts's formatAttachmentsPlaceholder
 * (host-side text-only lanes).
 *
 * Runs unconditionally for every image attachment regardless of whether the
 * live agent's own model has vision — a deliberate simplicity choice over
 * maintaining a per-provider vision-capability matrix, and it gives even a
 * vision-capable agent a head start.
 *
 * Never throws: a caption failure must not block message delivery.
 */
import crypto from 'crypto';

import sharp from 'sharp';

import { log } from '../../log.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
// Local, not cloud — the cloud-hosted gemma4:31b-cloud proved unreliable in
// practice (~7% success rate against this Ollama install, see conversation
// history), returning 500s or timing out on the large majority of calls,
// independent of any of our code (verified with raw curl). gemma3:4b is the
// smallest locally-resident vision-capable model available and completes
// reliably in well under TIMEOUT_MS.
const CAPTION_MODEL = process.env.CAPTION_MODEL || 'gemma3:4b';
const RESIZE_LONG_EDGE = 512;
const TIMEOUT_MS = 20_000;

const PROMPT =
  'Describe this image in detail for a friend who is legally blind. ' +
  'Give up to a dozen bullet points — objects, people, setting, visible text, ' +
  'colors, composition — concrete and specific. ' +
  'Respond with only the bullet points — no framing commentary ("here\'s a description...", ' +
  '"overall impression", "tone"), and no further offers of assistance (asking what to focus on next, ' +
  'offering to elaborate, closing questions) — none of that is your responsibility here.';

/**
 * When the user sent their own caption/text alongside the image, fold it in
 * as context rather than dropping it — tested against a case where the bare
 * PROMPT misidentified the subject (called a hand-drawn dragon a "unicorn")
 * and adding the user's caption as a hint let the model self-correct,
 * without just parroting the caption back. "Informed by, don't restate" is
 * the tested phrasing; a bare "the caption says X" invites restating it.
 */
function buildPrompt(userCaption?: string): string {
  if (!userCaption) return PROMPT;
  return (
    `${PROMPT} The sender captioned this image: "${userCaption}". ` +
    'Use that as context to help resolve anything ambiguous, but describe what you actually see — do not simply restate the caption.'
  );
}

const IMAGE_TYPES = new Set(['image', 'photo', 'sticker']);

/** True for an attachment whose bytes are an image — shared by the ingest, lazy-recaption, and vault-copy paths. */
export function isImageAttachment(att: Record<string, unknown>): boolean {
  if (typeof att.mimeType === 'string' && att.mimeType.startsWith('image/')) return true;
  return typeof att.type === 'string' && IMAGE_TYPES.has(att.type.toLowerCase());
}

/** Resize to 512px long edge and re-encode as JPEG. Shared by captionImage and the vault-attachment copy path. */
export async function resizeToBuffer(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes)
    .resize({ width: RESIZE_LONG_EDGE, height: RESIZE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg()
    .toBuffer();
}

async function resizeToBase64Jpeg(dataBase64: string): Promise<string> {
  const buffer = await resizeToBuffer(Buffer.from(dataBase64, 'base64'));
  return buffer.toString('base64');
}

export interface CaptionResult {
  ok: boolean;
  text: string;
}

/**
 * True for our own captionImage timeout firing (see TIMEOUT_MS above) — the
 * one unambiguous "the shared Ollama daemon was busy, not broken" signal, as
 * opposed to a fast error response (bad request, empty output, network
 * refusal). Shared by every retry site (notify.ts's async job, literal-tail
 * .ts's legacy lazy backfill) so contention gets a more forgiving retry
 * budget than a real failure everywhere captioning is attempted.
 */
export function isContentionError(errorText: string): boolean {
  return /aborted/i.test(errorText);
}

/**
 * Resize + caption a single image (base64 in). Used by the ingest path and
 * literal-tail's lazy re-caption. `userCaption` — the sender's own message
 * text, if any accompanied the image — is optional context folded into the
 * prompt (see buildPrompt); omit it and the plain PROMPT is used.
 */
export async function captionImage(dataBase64: string, userCaption?: string): Promise<CaptionResult> {
  try {
    const resized = await resizeToBase64Jpeg(dataBase64);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: CAPTION_MODEL,
          prompt: buildPrompt(userCaption),
          images: [resized],
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, text: `Ollama returned ${res.status} ${res.statusText}` };
      }
      const body = (await res.json()) as { response?: unknown };
      if (typeof body.response !== 'string' || !body.response.trim()) {
        return { ok: false, text: 'Ollama returned an empty response' };
      }
      return { ok: true, text: body.response.trim() };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: message };
  }
}

/** Short id derived from the attachment's own filename plus a random suffix — stable enough to reference in a "still processing" placeholder and later in the completion notice. */
function makeCaptionId(name: unknown): string {
  const base =
    (typeof name === 'string' ? name : 'image')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 24) || 'image';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Assign a `captionId` to every image attachment that doesn't already have
 * one. No network call — safe to run inline on the delivery path. No-op if
 * there's no `attachments` array or every image attachment is already
 * stamped (re-routing, retries).
 */
export function stampCaptionIds(contentStr: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments) || attachments.length === 0) return contentStr;

  let changed = false;
  for (const att of attachments) {
    if (!isImageAttachment(att) || typeof att.captionId === 'string') continue;
    att.captionId = makeCaptionId(att.name ?? att.filename);
    changed = true;
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}
