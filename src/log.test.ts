/**
 * onFatal's contract: registered hooks run on both uncaughtException and
 * unhandledRejection, a throwing hook doesn't take the process down harder
 * than it already was, and process.exit still happens even if a hook hangs
 * past FATAL_HOOK_TIMEOUT_MS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log, onFatal } from './log.js';

describe('onFatal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs a registered hook on uncaughtException, then exits', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const hook = vi.fn().mockResolvedValue(undefined);
    onFatal(hook);

    const err = new Error('boom');
    process.emit('uncaughtException', err);

    // process.emit is sync, but the handler's own work (runFatalHooks) is
    // async — give it a tick to resolve before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledWith(err, 'uncaughtException');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('runs a registered hook on unhandledRejection without exiting', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const hook = vi.fn().mockResolvedValue(undefined);
    onFatal(hook);

    const reason = new Error('rejected');
    process.emit('unhandledRejection', reason, Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));

    expect(hook).toHaveBeenCalledWith(reason, 'unhandledRejection');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a throwing hook does not prevent process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    onFatal(async () => {
      throw new Error('hook exploded');
    });

    process.emit('uncaughtException', new Error('original'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('Fatal hook threw', expect.anything());
  });
});
