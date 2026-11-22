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
  countGitSpawn,
  countWork,
  forbidWorkCounting,
  forbiddenWorkCountPolicy,
  GIT_SPAWNS_ENV,
  installWorkCounterDump,
  readGitSpawns,
  readWorkCounters,
  withWorkPhase,
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
    countWork('content.read', 2);
    countWork('content.read', 1);
    countWork('content.hashedBytes', 0);
    expect(readWorkCounters()).toStrictEqual({ ...allZero(), 'content.read': 3 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses n = %s, which is not a count', (n) => {
    expect(() => countWork('content.read', n)).toThrow(RangeError);
    expect(readWorkCounters()['content.read']).toBe(0);
  });

  it('refuses a name outside the closed set', () => {
    expect(() => countWork('not.a.counter' as Exclude<WorkCounter, 'git.calls'>, 1)).toThrow(RangeError);
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
    expect(() => countWork('content.read', 1)).toThrow(/forbids work counting/);
    expect(() => countGitSpawn({ via: 'runGit', args: ['status'], cwd: '/repo' })).toThrow(/forbids work counting/);
    expect(readGitSpawns()).toEqual([]);
  });

  it('reports a forbidden count once on stderr and does not count it, under vitest too', () => {
    // No environment decides this: production behaviour is the default even
    // here, where VITEST is set.
    expect(process.env['VITEST']).toBeTruthy();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    forbidWorkCounting('report');

    countWork('parse.dispatched', 1);
    countWork('content.read', 4);
    countGitSpawn({ via: 'runGit', args: ['status'], cwd: '/repo' });

    expect(readWorkCounters()).toStrictEqual(allZero());
    expect(readGitSpawns()).toEqual([]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^vat: work counter 'parse\.dispatched' counted .*not counted\n$/);
  });

  it('the dump carries the pid, the role and every counter', () => {
    countWork('store.reads.extent', 1);
    expect(__readWorkCounterDumpForTest('cli')).toStrictEqual({
      pid: process.pid,
      role: 'cli',
      counters: { ...allZero(), 'store.reads.extent': 1 },
      phases: {},
    });
  });

  it('installs no exit listener while both dump variables are unset', () => {
    vi.stubEnv(WORK_COUNTERS_ENV, '');
    vi.stubEnv(GIT_SPAWNS_ENV, '');
    const listeners = process.listenerCount('exit');
    installWorkCounterDump('cli');
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('installs the git spawn log\'s exit write alone when only its variable is set', () => {
    vi.stubEnv(WORK_COUNTERS_ENV, '');
    vi.stubEnv(GIT_SPAWNS_ENV, safePath.resolve(fileURLToPath(import.meta.url), '..'));
    const listeners = process.listenerCount('exit');
    installWorkCounterDump('cli');
    expect(process.listenerCount('exit')).toBe(listeners + 1);
  });

  it('refuses git.calls through countWork, at compile time and at run time', () => {
    // @ts-expect-error -- countWork's counter type excludes git.calls; this proves the compiler refuses it
    expect(() => countWork('git.calls', 1)).toThrow(RangeError);
    expect(readWorkCounters()['git.calls']).toBe(0);
  });

  it('counts a git spawn but records none while no spawn log is installed', () => {
    countGitSpawn({ via: 'runGit', args: ['status'], cwd: '/repo' });
    countGitSpawn({ via: 'snapshot', args: [], cwd: '/repo' });
    expect(readWorkCounters()['git.calls']).toBe(2);
    expect(readGitSpawns()).toEqual([]);
  });

  it('counts git.calls only through countGitSpawn, which logs each spawn with its phase once the log is installed', async () => {
    vi.stubEnv(WORK_COUNTERS_ENV, '');
    vi.stubEnv(GIT_SPAWNS_ENV, safePath.resolve(fileURLToPath(import.meta.url), '..'));
    installWorkCounterDump('cli');
    countGitSpawn({ via: 'snapshot', args: [], cwd: '/repo' });
    await withWorkPhase('resources', async () => {
      countGitSpawn({ via: 'runGit', args: ['ls-files', '-z'], cwd: '/repo/sub' });
      await Promise.resolve();
    });
    expect(readWorkCounters()['git.calls']).toBe(2);
    expect(__readWorkCounterDumpForTest('cli').phases['resources']?.['git.calls']).toBe(1);
    expect(readGitSpawns()).toEqual([
      { via: 'snapshot', args: [], cwd: '/repo', phase: null },
      { via: 'runGit', args: ['ls-files', '-z'], cwd: '/repo/sub', phase: 'resources' },
    ]);
  });

  // Windows only: a native cwd there carries backslashes; on POSIX toForwardSlash is the identity,
  // so the test has nothing to observe.
  it.runIf(process.platform === 'win32')('logs a spawn\'s working directory with forward slashes, a native spelling included', () => {
    vi.stubEnv(WORK_COUNTERS_ENV, '');
    vi.stubEnv(GIT_SPAWNS_ENV, safePath.resolve(fileURLToPath(import.meta.url), '..'));
    installWorkCounterDump('cli');
    countGitSpawn({ via: 'runGit', args: ['status'], cwd: String.raw`C:\repo\sub` });
    expect(readGitSpawns().map((spawn) => spawn.cwd)).toEqual(['C:/repo/sub']);
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
