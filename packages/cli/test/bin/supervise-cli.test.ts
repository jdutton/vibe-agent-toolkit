/**
 * The `vat` wrapper's wait on the CLI it spawned: a signal is forwarded on POSIX and never on
 * Windows, this process ends only once the CLI has, and the way the CLI ended. On a stand-in child,
 * with the raise and the exit stubbed. Through the real binary: `checks-supervisor-orphan` and
 * `signal-guard-group-ctrl-c` system tests.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { REPEAT_SIGNAL_WINDOW_MS } from '@vibe-agent-toolkit/utils/process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { superviseCli } from '../../src/bin/supervise-cli.js';

const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGBREAK'] as const;
const POSIX = process.platform !== 'win32';

class StandInCli extends EventEmitter {
  pid: number | undefined = 2_147_483_001;
  readonly kill = vi.fn(() => true);
}

function counts(): number[] {
  return SIGNALS.map((signal) => process.listenerCount(signal));
}

describe('superviseCli', () => {
  let baseline: number[];
  let processKill: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;
  let cli: StandInCli;

  beforeEach(() => {
    baseline = counts();
    processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out');
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    cli = new StandInCli();
    superviseCli(cli as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(counts()).toStrictEqual(baseline);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'a %s: forwarded on POSIX (never on Windows); nothing ends until the CLI exits, then this process dies of how the CLI died',
    async (signal) => {
      process.emit(signal, signal);
      process.emit(signal, signal);
      await Promise.resolve();

      expect(cli.kill.mock.calls).toStrictEqual(POSIX ? [[signal]] : []);
      // 🚨 Not before the CLI has exited: a wrapper that re-raised on receipt left the CLI running.
      expect(processKill).not.toHaveBeenCalledWith(process.pid, expect.anything());
      expect(exit).not.toHaveBeenCalled();

      cli.emit('exit', null, signal);

      if (POSIX) expect(processKill).toHaveBeenCalledWith(process.pid, signal);
      expect(exit).toHaveBeenCalledWith(2);
    },
  );

  it('a CLI that ends on a code after the signal: this process ends on that code, not of the signal', async () => {
    process.emit('SIGINT', 'SIGINT');
    await Promise.resolve();

    cli.emit('exit', 1, null);

    expect(processKill).not.toHaveBeenCalledWith(process.pid, expect.anything());
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a forward the platform refused (an `error` with the CLI running) is ignored: the CLI\'s exit still decides', () => {
    process.emit('SIGTERM', 'SIGTERM');
    cli.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));

    expect(exit).not.toHaveBeenCalled();
    cli.emit('exit', 0, null);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a CLI that never started (an `error` with no pid) ends this process with exit 2, its guard released', () => {
    cli.pid = undefined;
    cli.emit('error', new Error('spawn ENOENT'));

    expect(exit).toHaveBeenCalledWith(2);
    expect(counts()).toStrictEqual(baseline);
  });

  it('a CLI that ends with no signal received: its exit code, and the guard released', () => {
    cli.emit('exit', 0, null);

    expect(exit).toHaveBeenCalledWith(0);
    expect(counts()).toStrictEqual(baseline);
  });

  // 🚨 Swallowed for ever, a repeat could not end a CLI whose cleanup hung: the wrapper waited on it
  // for good. A repeat past the window kills the CLI and ends this process at once.
  it('a repeat AFTER the window: the CLI is SIGKILLed and this process dies of the repeat at once', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    try {
      process.emit('SIGTERM', 'SIGTERM');
      vi.advanceTimersByTime(REPEAT_SIGNAL_WINDOW_MS - 100);
      process.emit('SIGTERM', 'SIGTERM');
      expect(exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);
      process.emit('SIGINT', 'SIGINT');

      if (POSIX) {
        expect(processKill).toHaveBeenCalledWith(cli.pid, 'SIGKILL');
        expect(processKill).toHaveBeenLastCalledWith(process.pid, 'SIGINT');
      }
      expect(exit).toHaveBeenCalledExactlyOnceWith(2);
      // The CLI's own exit, later, changes nothing: this process has already ended.
      expect(counts()).toStrictEqual(baseline);
    } finally {
      vi.useRealTimers();
    }
  });
});
