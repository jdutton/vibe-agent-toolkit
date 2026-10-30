/**
 * The terminating-signal list the `vat` wrapper forwards and the checks supervisor guards, and the
 * re-raise both end with. What the re-raise does to a real process is pinned through the real
 * binary (`checks-supervisor-orphan.system.test.ts`); here, the decisions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isTerminatingSignal, reRaiseSignal, TERMINATING_SIGNALS } from '../src/process.js';

describe('TERMINATING_SIGNALS', () => {
  it('is the four signals that terminate by default disposition and can be handled — never SIGKILL', () => {
    expect([...TERMINATING_SIGNALS]).toStrictEqual(['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT']);
  });

  it('isTerminatingSignal answers for exactly that list', () => {
    expect(TERMINATING_SIGNALS.every((signal) => isTerminatingSignal(signal))).toBe(true);
    expect(['SIGKILL', 'SIGABRT', 'SIGSEGV', ''].some((signal) => isTerminatingSignal(signal))).toBe(false);
  });
});

describe('reRaiseSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('raises the signal on this process, then — still alive after the grace — exits with the fallback code', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    reRaiseSignal('SIGTERM', 2);

    if (process.platform === 'win32') {
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(wait).toHaveBeenCalledOnce();
    }
    expect(exit).toHaveBeenCalledWith(2);
  });
});
