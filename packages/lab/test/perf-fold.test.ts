/**
 * The arithmetic behind a `perf` row's CPU, per-surface wall and overlap mode.
 *
 * Pure folds over records, so every rule is checked with hand-written records
 * whose answers are worked out in the case, not by calling the function twice.
 */

import { describe, expect, it } from 'vitest';

import { foldDebugFacts, foldProcessRepeats, surfaceWalls, totalCpuMs } from '../src/facets/perf/process-fold.js';
import type { PerfProcessDump, ValidateDebugFacts } from '../src/facets/perf/types.js';

/**
 * A process record, defaulting what a case ignores.
 *
 * @param over - Fields to replace
 * @returns A complete record
 */
function record(over: Partial<PerfProcessDump> = {}): PerfProcessDump {
  return { pid: 10, ppid: 1, startMs: 1000, endMs: 2000, userCpuUs: 0, systemCpuUs: 0, banners: [], ...over };
}

/**
 * Debug facts, defaulting to an overlapped run.
 *
 * @param over - Fields to replace
 * @returns Complete facts
 */
function facts(over: Partial<ValidateDebugFacts> = {}): ValidateDebugFacts {
  return {
    checksOverlapped: 1,
    gateDeclinedBy: null,
    childStderrBytesAtTurn: 0,
    parentStoreWritesUntilChildExit: 0,
    parentParseCacheWritesUntilChildExit: 0,
    ...over,
  };
}

describe('totalCpuMs', () => {
  it('adds user and system CPU over every process and converts microseconds to milliseconds', () => {
    const records = [record({ userCpuUs: 1500, systemCpuUs: 500 }), record({ pid: 11, userCpuUs: 4000, systemCpuUs: 1000 })];

    expect(totalCpuMs(records)).toBe(7);
  });

  it('does not add wall: two overlapping processes of one second each still total only their CPU', () => {
    const records = [record({ startMs: 0, endMs: 1000, userCpuUs: 1000 }), record({ pid: 11, startMs: 0, endMs: 1000, userCpuUs: 1000 })];

    expect(totalCpuMs(records)).toBe(2);
  });
});

describe('surfaceWalls', () => {
  it('runs each banner to the next, and the last to the process exit', () => {
    const walls = surfaceWalls(
      record({
        endMs: 900,
        banners: [
          { name: 'resources', atMs: 100 },
          { name: 'checks', atMs: 350 },
          { name: 'build', atMs: 800 },
        ],
      }),
    );

    expect(walls).toEqual([
      { name: 'resources', wallMs: 250 },
      { name: 'checks', wallMs: 450 },
      { name: 'build', wallMs: 100 },
    ]);
  });

  it('keeps a surface that is named twice as two intervals rather than merging or dropping one', () => {
    const walls = surfaceWalls(
      record({ endMs: 40, banners: [{ name: 'a', atMs: 0 }, { name: 'a', atMs: 10 }] }),
    );

    expect(walls).toEqual([{ name: 'a', wallMs: 10 }, { name: 'a#2', wallMs: 30 }]);
  });
});

describe('foldProcessRepeats', () => {
  const surfaced = (endMs: number, secondAtMs: number): PerfProcessDump =>
    record({ endMs, userCpuUs: 2000, banners: [{ name: 'one', atMs: 0 }, { name: 'two', atMs: secondAtMs }] });

  it('reports statistics over repeats for total CPU and for each surface', () => {
    const folded = foldProcessRepeats([[surfaced(100, 40)], [surfaced(100, 50)], [surfaced(100, 60)]]);

    expect(folded).toMatchObject({
      cpuMs: { medianMs: 2, minMs: 2, maxMs: 2 },
      surfaces: { one: { medianMs: 50, minMs: 40, maxMs: 60 }, two: { medianMs: 50, minMs: 40, maxMs: 60 } },
    });
  });

  it('says no CPU was measured, not zero, when no repeat has a vat process record', () => {
    expect(foldProcessRepeats([[], []])).toEqual({ cpuMs: null, surfaces: {} });
  });

  it('refuses repeats that ran a different number of vat processes', () => {
    const folded = foldProcessRepeats([[record()], [record(), record({ pid: 11 })]]);

    expect(folded).toContain('disagree on how many vat processes');
  });

  it('refuses a repeat where two processes both wrote banners', () => {
    const folded = foldProcessRepeats([[surfaced(100, 40), surfaced(100, 40)]]);

    expect(folded).toContain('2 vat processes wrote');
  });

  it('refuses repeats that ran different surfaces', () => {
    const folded = foldProcessRepeats([[surfaced(100, 40)], [record({ endMs: 100, banners: [{ name: 'one', atMs: 0 }] })]]);

    expect(folded).toContain('disagree on which surfaces ran');
  });
});

describe('foldDebugFacts', () => {
  it('is unknown, never 0, when no repeat wrote facts', () => {
    expect(foldDebugFacts([null, null])).toEqual({ checksOverlapped: null, gateDeclinedBy: null });
  });

  it('reports the mode and, for a declined gate, what declined it', () => {
    const declined = { condition: 'member', member: 'docs/a.md', route: 'readRoute' } as const;

    expect(foldDebugFacts([facts({ checksOverlapped: 0, gateDeclinedBy: declined }), facts({ checksOverlapped: 0, gateDeclinedBy: declined })])).toEqual({
      checksOverlapped: 0,
      gateDeclinedBy: declined,
    });
    expect(foldDebugFacts([facts()])).toEqual({ checksOverlapped: 1, gateDeclinedBy: null });
  });

  it('refuses facts present in some repeats only', () => {
    expect(foldDebugFacts([facts(), null])).toContain('only 1 of 2 repeats');
  });

  it('refuses repeats that disagree on the mode, or on what declined the gate', () => {
    expect(foldDebugFacts([facts(), facts({ checksOverlapped: 0 })])).toContain('disagree');
    const a = facts({ checksOverlapped: 0, gateDeclinedBy: { condition: 'debug' } });
    const b = facts({ checksOverlapped: 0, gateDeclinedBy: { condition: 'cores' } });

    expect(foldDebugFacts([a, b])).toContain('disagree');
  });
});
