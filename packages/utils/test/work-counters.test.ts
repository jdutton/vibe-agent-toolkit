/**
 * The work-counter contract: one closed name set, an `n` that must be a count,
 * a thread that may forbid counting, and a dump that carries every counter.
 *
 * The dump's WRITE is `writeTimingDump`'s, tested in `timing-dump.test.ts`; what
 * is held here is the body it is handed, read without touching the disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countWork,
  forbidWorkCounting,
  installWorkCounterDump,
  readWorkCounters,
  WORK_COUNTER_NAMES,
  WORK_COUNTERS_ENV,
  type WorkCounter,
} from '../src/work-counters.js';
import { __readWorkCounterDumpForTest, __resetWorkCountersForTest } from '../src/work-counters.js';

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

  it('throws on a count after forbidWorkCounting, under test', () => {
    forbidWorkCounting();
    expect(() => countWork('parse.dispatched', 1)).toThrow(/forbids work counting/);
    expect(readWorkCounters()['parse.dispatched']).toBe(0);
  });

  it('outside a test, reports a forbidden count once on stderr and does not count it', () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    forbidWorkCounting();

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
});
