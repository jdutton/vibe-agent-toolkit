/**
 * The supervision guard exists for exactly as long as the supervision does: installed before the
 * progress directory is minted, and gone once that directory is removed AND the child is gone,
 * however the run ends. Not once the run SETTLES: a run settled on a refused kill or a throwing
 * poll may leave its child alive, and every handler must still take that child down. So a
 * long-lived process (`vat validate`, a test runner) does not accumulate them, and its own signal
 * handling is back the moment the child is.
 *
 * What the handlers DO is pinned through the real binary in
 * `checks-supervisor-orphan.system.test.ts`; here their lifetime on a stand-in child, the watchdog
 * poll's own kill when it throws, and the watchdog settling on a kill that never lands.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type * as Utils from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { __internal, type ProgressLog, superviseCheck, withProgressLog } from '../../src/commands/resources/check-supervisor.js';

const { spawnMock, statMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), statMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../../src/utils/vat-bin-path.js', () => ({ resolveVatBinPath: () => 'vat-bin.js' }));
vi.mock('@vibe-agent-toolkit/utils', async (original) => ({
  ...(await original<typeof Utils>()),
  requireFollowedStatSync: statMock,
}));

const GUARDED_EVENTS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'exit'] as const;

/** A stand-in for a spawned child: the fields the guard reads, and `close`. */
class StandInChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);

  /** End as Node reports a child's end: the code or signal is set, then `close`. */
  end(ending: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.exitCode = ending.code;
    this.signalCode = ending.signal;
    this.emit('close', ending.code, ending.signal);
  }
}

/** This process's listener count for each guarded event. */
function listenerCounts(): Record<string, number> {
  return Object.fromEntries(GUARDED_EVENTS.map((event) => [event, process.listenerCount(event)]));
}

/** A stand-in, as the `ChildProcess` the guard is typed for — it reads only the stand-in's fields. */
function asChild(child: StandInChild): ChildProcess {
  return child as unknown as ChildProcess;
}

/** Install the guard, watching a stand-in child; returns its release. */
function guard(child: StandInChild): () => void {
  const installed = __internal.guardSupervision();
  installed.watch(asChild(child));
  return installed.release;
}

/** A progress log for `superviseCheck`, under a guard that watches nothing until it is spawned. */
function progressLog(): ProgressLog {
  return { path: 'progress.jsonl', guard: __internal.guardSupervision() };
}

describe('the supervision guard — its lifetime', () => {
  const supervised: Array<{ child: StandInChild; release: () => void }> = [];
  let before: Record<string, number>;

  beforeAll(() => {
    before = listenerCounts();
  });

  // The suite itself leaves the runner's process as it found it — every handler, `exit` included.
  afterAll(() => {
    expect(listenerCounts()).toStrictEqual(before);
  });

  afterEach(() => {
    // A red case must not leave its handlers on the runner's process. The child ends FIRST: a
    // release with the child still alive keeps the exit guard until the child's `close`, which a
    // stand-in left running never emits — so releasing alone would leak an `exit` listener.
    for (const { child, release } of supervised.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.end({ code: null, signal: 'SIGKILL' });
      release();
    }
  });

  it('adds exactly one handler per guarded event while it supervises', () => {
    const baseline = listenerCounts();
    const child = new StandInChild();

    supervised.push({ child, release: guard(child) });

    expect(listenerCounts()).toStrictEqual(Object.fromEntries(GUARDED_EVENTS.map((event) => [event, (baseline[event] ?? 0) + 1])));
  });

  it.each([
    ['a completed run (exit 0)', { code: 0, signal: null }],
    ['a failed run (exit 1)', { code: 1, signal: null }],
    ['a killed run (SIGKILL)', { code: null, signal: 'SIGKILL' as const }],
  ])('returns to baseline when %s ends the supervision', (_label, ending) => {
    const baseline = listenerCounts();
    const child = new StandInChild();
    const release = guard(child);

    child.end(ending);
    release();

    expect(listenerCounts()).toStrictEqual(baseline);
  });

  it('returns to baseline when released before any child was spawned', () => {
    const baseline = listenerCounts();

    __internal.guardSupervision().release();

    expect(listenerCounts()).toStrictEqual(baseline);
  });

  it('returns to baseline when the child never started', () => {
    const baseline = listenerCounts();
    const child = new StandInChild();
    child.pid = undefined;

    guard(child)();

    expect(listenerCounts()).toStrictEqual(baseline);
  });

  // 🚨 A run settled with its child alive — a refused kill, a poll that threw — used to drop the
  // signal handlers at once: a SIGTERM meanwhile ended this process and orphaned the child.
  it('keeps every handler past a run that settled with its child alive, until the child ends', () => {
    const baseline = listenerCounts();
    const child = new StandInChild();

    guard(child)();

    expect(listenerCounts()).toStrictEqual(Object.fromEntries(GUARDED_EVENTS.map((event) => [event, (baseline[event] ?? 0) + 1])));
    child.end({ code: null, signal: 'SIGKILL' });
    expect(listenerCounts()).toStrictEqual(baseline);
  });
});

describe('the guard spans the progress log\'s whole life (withProgressLog)', () => {
  // 🚨 The guard used to be installed only once the child was spawned, and released before the
  // directory was removed — a signal between the directory's mkdtemp and the spawn, or during its
  // removal, met no handler and left the directory behind.
  it('is installed before work runs — no child yet — and the exit guard then removes the directory', async () => {
    const baseline = listenerCounts();
    let during: Record<string, number> | undefined;
    let dirExistedAfterExit = true;

    await withProgressLog(async (log) => {
      during = listenerCounts();
      const dir = dirname(log.path);
      writeFileSync(log.path, '', 'utf-8');
      const onExit = process.listeners('exit').at(-1) as () => void;
      onExit();
      dirExistedAfterExit = existsSync(dir);
    });

    expect(during).toStrictEqual(Object.fromEntries(GUARDED_EVENTS.map((event) => [event, (baseline[event] ?? 0) + 1])));
    expect(dirExistedAfterExit).toBe(false);
    expect(listenerCounts()).toStrictEqual(baseline);
  });
});

describe('the watchdog poll that throws', () => {
  // 🚨 A poll that cannot stat the progress log has no reading, and the timer it runs in is
  // outside every caller's `try`. The poll's own catch must kill the child: once the timer stops,
  // nothing else bounds it — the `exit` guard fires only if this process ends, and a caller that
  // publishes the failure (`vat validate`'s RUN_INCOMPLETE) has not ended yet.
  it('kills the child with SIGKILL and rejects with the throw', async () => {
    const baseline = listenerCounts();
    const child = new StandInChild();
    child.kill.mockImplementation(() => {
      setImmediate(() => child.end({ code: null, signal: 'SIGKILL' }));
      return true;
    });
    spawnMock.mockReturnValue(child);
    statMock.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied, stat progress.jsonl'), { code: 'EACCES' });
    });

    const log = progressLog();
    const run = superviseCheck({ args: [], log, budgetMs: 500, format: 'json' });

    await expect(run).rejects.toThrow('EACCES');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // The child's `close` releases every handler.
    log.guard.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(listenerCounts()).toStrictEqual(baseline);
  });
});

describe('a SIGKILL the kernel ACCEPTS that does not end the child', () => {
  // 🚨 A child in uninterruptible I/O takes SIGKILL and does not die until the I/O returns. The
  // kill is not refused, so no `error` fires — and the watchdog used to re-send SIGKILL forever,
  // the supervisor itself becoming the unbounded hang. It must settle, naming the pid.
  it('settles as kill-failed, not refused, naming the pid, after a bounded number of polls', async () => {
    const child = new StandInChild();
    spawnMock.mockReturnValue(child);
    statMock.mockImplementation(() => ({ size: 0 }));
    const log = progressLog();
    // The watchdog's own clock and timer, driven by hand: 20 polls on a real clock would be seconds.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    try {
      const run = superviseCheck({ args: [], log, budgetMs: 100, format: 'json' });
      await vi.advanceTimersByTimeAsync(5000);

      await expect(run).resolves.toMatchObject({
        outcome: 'abnormal',
        death: { kind: 'kill-failed', pid: 4242, refused: false },
      });
      // It kept trying first — more than once — and then stopped.
      const sent = child.kill.mock.calls.length;
      expect(sent).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(child.kill.mock.calls).toHaveLength(sent);
    } finally {
      vi.useRealTimers();
      child.end({ code: null, signal: 'SIGKILL' });
      log.guard.release();
    }
  });
});
