/**
 * The terminating-signal list, the ONE guard every handler goes through, and the re-raise it ends
 * with. What the re-raise does to a real process is pinned through the real binary
 * (`checks-supervisor-orphan.system.test.ts`, `signal-guard-group-ctrl-c.system.test.ts`); here, the
 * decisions — on `process.emit`, with the raise and the exit stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleTerminatingSignals,
  isTerminatingSignal,
  reRaiseSignal,
  TERMINATING_SIGNALS,
  type TerminatingSignalGuard,
} from '../src/process.js';

describe('TERMINATING_SIGNALS', () => {
  it('is the five signals that terminate by default disposition and can be handled — never SIGKILL', () => {
    expect([...TERMINATING_SIGNALS]).toStrictEqual(['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGBREAK']);
  });

  it('isTerminatingSignal answers for exactly that list', () => {
    expect(TERMINATING_SIGNALS.every((signal) => isTerminatingSignal(signal))).toBe(true);
    expect(['SIGKILL', 'SIGABRT', 'SIGSEGV', ''].some((signal) => isTerminatingSignal(signal))).toBe(false);
  });
});

/** The raise and the exit, stubbed: what reRaiseSignal would have done to this process. */
function stubEnding(): { kill: ReturnType<typeof vi.spyOn>; exit: ReturnType<typeof vi.spyOn> } {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out');
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  return { kill, exit };
}

describe('reRaiseSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('raises the signal on this process, then — still alive after the grace — exits with the fallback code', () => {
    const { kill, exit } = stubEnding();

    reRaiseSignal('SIGTERM', 2);

    if (process.platform === 'win32') {
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    }
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('removes every listener for the signal first, so the raise reaches the default disposition', () => {
    stubEnding();
    const listener = vi.fn();
    process.on('SIGQUIT', listener);

    reRaiseSignal('SIGQUIT', 2);

    expect(process.listenerCount('SIGQUIT')).toBe(0);
  });
});

/** This process's listener count for every terminating signal. */
function counts(): number[] {
  return TERMINATING_SIGNALS.map((signal) => process.listenerCount(signal));
}

/** Every guard a case installed, released after it. */
const guards: TerminatingSignalGuard[] = [];

/** Install a guard with exit fallback 2, remembered for release. */
function guard(cleanup: () => unknown): TerminatingSignalGuard {
  const installed = handleTerminatingSignals({ cleanup, fallbackExitCode: 2 });
  guards.push(installed);
  return installed;
}

describe('handleTerminatingSignals', () => {
  let baseline: number[];

  beforeEach(() => {
    baseline = counts();
  });

  afterEach(() => {
    for (const installed of guards.splice(0)) installed.release();
    vi.restoreAllMocks();
    expect(counts()).toStrictEqual(baseline);
  });

  it('listens on every terminating signal while a guard lives, and on none once it is released without one', () => {
    const installed = guard(() => undefined);
    expect(counts()).toStrictEqual(baseline.map((count) => count + 1));

    expect(installed.release()).toBe(true);
    expect(counts()).toStrictEqual(baseline);
  });

  it('a synchronous cleanup: runs once, then this process dies of the signal in the same turn', () => {
    const { kill, exit } = stubEnding();
    const cleanup = vi.fn();
    guard(cleanup);

    process.emit('SIGTERM', 'SIGTERM');

    expect(cleanup).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(exit).toHaveBeenCalledWith(2);
  });

  // 🚨 The class this guard closes: a handler that removed itself on the first signal, so the
  // second — a group Ctrl-C under the wrapper delivers two — killed the process mid-cleanup.
  it('an asynchronous cleanup: a repeat is SWALLOWED until it settles, and only then does the process end', async () => {
    const { kill, exit } = stubEnding();
    let finish: () => void = () => undefined;
    const cleanup = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const installed = guard(cleanup);

    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledOnce();
    // Still listening — a repeat meets the guard, never the default disposition.
    expect(counts()).toStrictEqual(baseline.map((count) => count + 1));
    expect(kill).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    // A release meanwhile does not drop the ending the signal started.
    expect(installed.release()).toBe(false);

    finish();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(2);
    });
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGINT');
    expect(counts()).toStrictEqual(baseline);
  });

  it('a cleanup that rejects — or throws — still ends the process', async () => {
    const { exit } = stubEnding();
    guard(() => Promise.reject(new Error('could not remove')));
    guard(() => {
      throw new Error('threw');
    });

    process.emit('SIGHUP', 'SIGHUP');

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(2);
    });
  });

  it('two live guards: both clean up, and the process ends once the slower has settled', async () => {
    const { exit } = stubEnding();
    const order: string[] = [];
    let finish: () => void = () => undefined;
    guard(() => {
      order.push('sync');
    });
    guard(() => new Promise<void>((resolve) => {
      finish = () => {
        order.push('async');
        resolve();
      };
    }));

    process.emit('SIGINT', 'SIGINT');
    await Promise.resolve();
    expect(order).toStrictEqual(['sync']);
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledOnce();
    });
    expect(order).toStrictEqual(['sync', 'async']);
  });

  it('releaseOrAwaitEnding: resolves once released without a signal', async () => {
    const installed = guard(() => undefined);

    await expect(installed.releaseOrAwaitEnding()).resolves.toBeUndefined();
    expect(counts()).toStrictEqual(baseline);
  });

  // 🚨 Work that goes on to publish or exit must not do so while a signal is ending the process.
  it('releaseOrAwaitEnding: never settles once a signal is ending the process', async () => {
    const { exit } = stubEnding();
    let finish: () => void = () => undefined;
    const installed = guard(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    process.emit('SIGINT', 'SIGINT');

    let settled = false;
    installed.releaseOrAwaitEnding().then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    finish();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  });
});
