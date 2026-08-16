import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdapterMock = vi.fn();
const deliverMock = vi.fn().mockResolvedValue('platform-msg-id');
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: () => getAdapterMock(),
}));

const getOwnersMock = vi.fn();
const getGlobalAdminsMock = vi.fn();
vi.mock('./modules/permissions/db/user-roles.js', () => ({
  getOwners: () => getOwnersMock(),
  getGlobalAdmins: () => getGlobalAdminsMock(),
}));

const ensureUserDmMock = vi.fn();
vi.mock('./modules/permissions/user-dm.js', () => ({
  ensureUserDm: (userId: string) => ensureUserDmMock(userId),
}));

import { registerCrashNotify } from './crash-notify.js';

// Registered once, not per-test — onFatal's hook list is module-private and
// never cleared, so registering again each test would fire every prior
// test's hook too on the next process.emit, multiplying call counts.
registerCrashNotify();

// log.ts's uncaughtException handler calls the real process.exit(1) after
// running hooks — vitest's runner treats an unmocked process.exit as itself
// a failure, which surfaces as an unhandledRejection and re-triggers this
// same hook a second time, doubling every call count below. Mock it away.
vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

async function emitAndFlush(): Promise<void> {
  process.emit('uncaughtException', new Error('boom'));
  // The handler chain is async (runFatalHooks); two ticks lets both the
  // hook's own await and notifyRecipients' Promise.allSettled resolve.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('crash-notify', () => {
  beforeEach(() => {
    getAdapterMock.mockReset().mockReturnValue({ deliver: deliverMock });
    deliverMock.mockClear();
    getOwnersMock.mockReset();
    getGlobalAdminsMock.mockReset();
    ensureUserDmMock.mockReset();
  });

  it('DMs every owner and global admin, deduped', async () => {
    getOwnersMock.mockReturnValue([{ user_id: 'telegram:1', role: 'owner', agent_group_id: null }]);
    getGlobalAdminsMock.mockReturnValue([
      { user_id: 'telegram:1', role: 'admin', agent_group_id: null }, // same user as owner — dedupe
      { user_id: 'telegram:2', role: 'admin', agent_group_id: null },
    ]);
    ensureUserDmMock.mockImplementation((userId: string) =>
      Promise.resolve({ channel_type: 'telegram', platform_id: userId.split(':')[1] }),
    );

    await emitAndFlush();

    expect(ensureUserDmMock).toHaveBeenCalledWith('telegram:1');
    expect(ensureUserDmMock).toHaveBeenCalledWith('telegram:2');
    expect(ensureUserDmMock).toHaveBeenCalledTimes(2);
    expect(deliverMock).toHaveBeenCalledTimes(2);
    const [channelType, , threadId, kind, content] = deliverMock.mock.calls[0];
    expect(channelType).toBe('telegram');
    expect(threadId).toBeNull();
    expect(kind).toBe('chat-sdk');
    expect(JSON.parse(content).text).toContain('NanoClaw crashed');
    expect(JSON.parse(content).text).toContain('boom');
  });

  it('skips quietly when there is no delivery adapter yet', async () => {
    getAdapterMock.mockReturnValue(null);
    getOwnersMock.mockReturnValue([{ user_id: 'telegram:1', role: 'owner', agent_group_id: null }]);
    getGlobalAdminsMock.mockReturnValue([]);

    await emitAndFlush();

    expect(ensureUserDmMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('skips quietly when there are no owners or admins', async () => {
    getOwnersMock.mockReturnValue([]);
    getGlobalAdminsMock.mockReturnValue([]);

    await emitAndFlush();

    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('a user with no reachable DM is skipped, others still get notified', async () => {
    getOwnersMock.mockReturnValue([
      { user_id: 'telegram:1', role: 'owner', agent_group_id: null },
      { user_id: 'telegram:2', role: 'owner', agent_group_id: null },
    ]);
    getGlobalAdminsMock.mockReturnValue([]);
    ensureUserDmMock.mockImplementation((userId: string) =>
      Promise.resolve(userId === 'telegram:1' ? null : { channel_type: 'telegram', platform_id: '2' }),
    );

    await emitAndFlush();

    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
