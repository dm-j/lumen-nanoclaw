/**
 * DMs owners + global admins when the host hits an uncaught exception or
 * unhandled rejection — the class of bug that otherwise only shows up as
 * silence (a crash loop with no reply, discovered only because a human
 * happened to notice and go read logs.nanoclaw.error.log).
 *
 * Deliberately narrow: fatal-level only (log.error() calls — delivery
 * failures, individual request errors — stay log-only, since those happen
 * often enough to flood a DM). See log.ts's onFatal for why this is wired
 * as a hook rather than log.ts importing delivery/permissions directly.
 */
import { getDeliveryAdapter } from './delivery.js';
import type { FatalKind } from './log.js';
import { log, onFatal } from './log.js';
import { getGlobalAdmins, getOwners } from './modules/permissions/db/user-roles.js';
import { ensureUserDm } from './modules/permissions/user-dm.js';

const MAX_MESSAGE_LEN = 500;

function summarize(err: unknown): string {
  if (err instanceof Error) {
    const firstStackLine = err.stack?.split('\n')[1]?.trim();
    return `${err.constructor.name}: ${err.message}${firstStackLine ? `\n${firstStackLine}` : ''}`;
  }
  return String(err);
}

function labelFor(kind: FatalKind): string {
  return kind === 'uncaughtException' ? '💥 NanoClaw crashed' : '⚠️ NanoClaw hit an unhandled rejection';
}

async function notifyRecipients(err: unknown, kind: FatalKind): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('crash-notify: no delivery adapter registered yet, skipping notification');
    return;
  }

  // Owners + global admins, deduped — a scoped agent-group admin has no
  // reason to hear about a host-level crash that isn't specific to their
  // group.
  const userIds = new Set<string>();
  for (const role of [...getOwners(), ...getGlobalAdmins()]) userIds.add(role.user_id);
  if (userIds.size === 0) {
    log.warn('crash-notify: no owners or global admins to notify');
    return;
  }

  const text = `${labelFor(kind)}\n${summarize(err).slice(0, MAX_MESSAGE_LEN)}`;

  await Promise.allSettled(
    [...userIds].map(async (userId) => {
      const dm = await ensureUserDm(userId);
      if (!dm) return;
      await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text }));
    }),
  );
}

/** Call once at startup. Registers the DM-on-crash hook with log.ts. */
export function registerCrashNotify(): void {
  onFatal(async (err, kind) => {
    try {
      await notifyRecipients(err, kind);
    } catch (notifyErr) {
      // Never let a failure to notify mask or delay the original crash.
      log.error('crash-notify: failed to notify', { err: notifyErr });
    }
  });
}
