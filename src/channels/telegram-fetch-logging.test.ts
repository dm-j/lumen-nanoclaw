import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import { withTelegramFailureLogging } from './telegram.js';

const TOKEN_URL = 'https://api.telegram.org/bot123:SECRET/getUpdates';

afterEach(() => vi.restoreAllMocks());

describe('withTelegramFailureLogging', () => {
  it('logs the socket cause and duration, never the token, and rethrows the same error', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

    await expect(withTelegramFailureLogging(() => Promise.reject(failure))(TOKEN_URL)).rejects.toBe(failure);

    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('Telegram fetch failed');
    expect(fields).toMatchObject({ method: 'getUpdates', cause: 'ECONNRESET' });
    expect(typeof fields.durationMs).toBe('number');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  it('stays quiet for aborts and for other hosts', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(withTelegramFailureLogging(() => Promise.reject(abort))(TOKEN_URL)).rejects.toBe(abort);
    await expect(
      withTelegramFailureLogging(() => Promise.reject(new Error('x')))('https://example.com/'),
    ).rejects.toThrow('x');
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes successful responses through untouched', async () => {
    const res = new Response('ok');
    expect(await withTelegramFailureLogging(() => Promise.resolve(res))(TOKEN_URL)).toBe(res);
  });
});
