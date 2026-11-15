/**
 * The work-counter contract: one closed name set, an `n` that must be a count,
 * a thread that may forbid counting, and a dump that carries every counter.
 *
 * The dump's WRITE is `writeTimingDump`'s, tested in `timing-dump.test.ts`; what
 * is held here is the body it is handed, read without touching the disk.
 */

import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safePath } from '../src/path-core.js';
import {
  __readWorkCounterDumpForTest,
  __resetWorkCountersForTest,
  __throwOnForbiddenWorkCountForTest,
} from '../src/testing.js';
import {
  countWork,
  forbidWorkCounting,
  forbiddenWorkCountPolicy,
  installWorkCounterDump,
  readWorkCounters,
  WORK_COUNTER_NAMES,
  WORK_COUNTER_ROLES,
  WORK_COUNTERS_ENV,
  type WorkCounter,
} from '../src/work-counters.js';

/** Every counter at zero: what a reset leaves, and what a fresh process starts with. */
function allZero(): Record<WorkCounter, number> {
  return Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, 0])) as Record<WorkCounter, number>;
}

describe('work counters', () => {
  beforeEach(() => {
    __resetWorkCountersForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    __resetWorkCountersForTest();
  });

  it('names each counter once', () => {
    expect(new Set(WORK_COUNTER_NAMES).size).toBe(WORK_COUNTER_NAMES.length);
  });

  it('reads every counter, zeros included', () => {
    expect(readWorkCounters()).toStrictEqual(allZero());
  });

  it('adds n to the named counter and nothing else', () => {
    countWork('git.calls', 2);
    countWork('git.calls', 1);
    countWork('content.hashedBytes', 0);
    expect(readWorkCounters()).toStrictEqual({ ...allZero(), 'git.calls': 3 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses n = %s, which is not a count', (n) => {
    expect(() => countWork('git.calls', n)).toThrow(RangeError);
    expect(readWorkCounters()['git.calls']).toBe(0);
  });

  it('refuses a name outside the closed set', () => {
    expect(() => countWork('not.a.counter' as WorkCounter, 1)).toThrow(RangeError);
  });

  it('hands out a snapshot, never the live storage', () => {
    const before = readWorkCounters();
    countWork('extent.served', 1);
    expect(before['extent.served']).toBe(0);
  });

  it('throws on a forbidden count once a test turns the throw on', () => {
    __throwOnForbiddenWorkCountForTest();
    forbidWorkCounting(forbiddenWorkCountPolicy());
    expect(() => countWork('parse.dispatched', 1)).toThrow(/forbids work counting/);
    expect(readWorkCounters()['parse.dispatched']).toBe(0);
  });

  it('tells a thread it starts to report a forbidden count, or to throw once a test turns the throw on', () => {
    expect(forbiddenWorkCountPolicy()).toBe('report');
    __throwOnForbiddenWorkCountForTest();
    expect(forbiddenWorkCountPolicy()).toBe('throw');
  });

  it('throws on a forbidden count on a thread told to throw, with no seam of its own turned on', () => {
    // What a parse worker does with the policy its parent handed it.
    forbidWorkCounting('throw');
    expect(() => countWork('git.calls', 1)).toThrow(/forbids work counting/);
  });

  it('reports a forbidden count once on stderr and does not count it, under vitest too', () => {
    // No environment decides this: production behaviour is the default even
    // here, where VITEST is set.
    expect(process.env['VITEST']).toBeTruthy();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    forbidWorkCounting('report');

    countWork('parse.dispatched', 1);
    countWork('git.calls', 4);

    expect(readWorkCounters()).toStrictEqual(allZero());
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^vat: work counter 'parse\.dispatched' counted .*not counted\n$/);
  });

  it('the dump carries the pid, the role and every counter', () => {
    countWork('store.reads.persistent', 1);
    expect(__readWorkCounterDumpForTest('cli')).toStrictEqual({
      pid: process.pid,
      role: 'cli',
      counters: { ...allZero(), 'store.reads.persistent': 1 },
    });
  });

  it('installs no exit listener while the dump variable is unset', () => {
    vi.stubEnv(WORK_COUNTERS_ENV, '');
    const listeners = process.listenerCount('exit');
    installWorkCounterDump('cli');
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('reports a directory it cannot make once, and registers no exit write to report it again', () => {
    // Under this test file, an existing regular file: no platform makes it.
    // Never a NUL byte, which an environment variable truncates at.
    vi.stubEnv(WORK_COUNTERS_ENV, safePath.join(fileURLToPath(import.meta.url), 'dump'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const listeners = process.listenerCount('exit');

    installWorkCounterDump('cli');

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^vat: work-counter dump failed for /);
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('the roles tuple names every role a dump may carry', () => {
    expect(WORK_COUNTER_ROLES).toEqual(['wrapper', 'cli']);
  });
});
