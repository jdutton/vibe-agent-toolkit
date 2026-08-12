/**
 * The load guard exists to keep one specific lie out of the perf report: that a
 * measurement taken on a busy machine was a measurement of vat. These tests pin
 * the four ways that lie gets in.
 *
 * 1. **Reading only `before`.** Load that arrives partway through the repeats
 *    contaminates them just as thoroughly, and a guard that samples once at the
 *    start is blind to exactly the case a long capture invites. The positive
 *    control below varies *only* `after`, so an implementation that ignores it
 *    returns the same verdict for both halves and fails.
 * 2. **Reading the load without the CPU count.** A load of 4 is a quarter of a
 *    16-core machine and twice a 2-core one. The same number has to produce
 *    opposite verdicts.
 * 3. **Believing Windows' `[0, 0, 0]`.** That is "no data", not "idle". An
 *    unmeasurable reading is `null` and `available` is `false`; a reader who
 *    sees `contaminated: false` must be able to tell which of the two facts it
 *    is stating.
 * 4. **Letting a lost reading launder a busy one.** `available: false` with
 *    `contaminated: true` is a documented guarantee of the contract, not an
 *    implementation detail, so it gets its own pinned test.
 */

import { platform } from 'node:os';

import { describe, expect, it } from 'vitest';

import { PerfBodySchema } from '../src/facets/perf/types.js';
import {
  DEFAULT_LOAD_PER_CPU_THRESHOLD,
  judgeLoad,
  readLoad,
} from '../src/harness/load-guard.js';

/** A machine with enough cores that the arithmetic below stays readable. */
const CPUS = 8;

/** The `load` half of the real, strict report schema. */
const LoadSchema = PerfBodySchema.shape.load;

describe('judgeLoad', () => {
  it('reports an idle machine as clean', () => {
    const judged = judgeLoad(0.2, 0.3, CPUS);

    expect(judged).toEqual({
      before: 0.2,
      after: 0.3,
      cpus: CPUS,
      available: true,
      contaminated: false,
    });
  });

  it('produces a body the strict perf schema accepts', () => {
    // Field-for-field conformance against the shipped schema rather than
    // against a hand-written expectation: an extra key, a missing `available`,
    // or a `null` where the schema wants a number is a producer bug, and this
    // is the same `.strict()` object the report writer will run.
    expect(() => LoadSchema.parse(judgeLoad(0.2, 0.3, CPUS))).not.toThrow();
    expect(() => LoadSchema.parse(judgeLoad(null, null, CPUS))).not.toThrow();
  });

  it('reports contamination when the machine was busy before the first repeat', () => {
    expect(judgeLoad(12, 0.3, CPUS).contaminated).toBe(true);
  });

  it('consults the reading taken after the last repeat, not only the one before', () => {
    // Positive control for "both readings are consulted". The two calls differ
    // in `after` and nothing else, so an implementation that judges on `before`
    // alone answers `false` twice and this test fails.
    const quietThroughout = judgeLoad(0.3, 0.3, CPUS);
    const loadedAfterwards = judgeLoad(0.3, 12, CPUS);

    expect(quietThroughout.contaminated).toBe(false);
    expect(loadedAfterwards.contaminated).toBe(true);
    expect(loadedAfterwards.before).toBe(quietThroughout.before);
  });

  it('scales the threshold with the CPU count', () => {
    // One load figure, two machines, opposite verdicts — proof the judgement is
    // load *per CPU* and not a bare load ceiling.
    expect(judgeLoad(4, 4, 16).contaminated).toBe(false);
    expect(judgeLoad(4, 4, 2).contaminated).toBe(true);
  });

  it('treats a machine sitting exactly on the threshold as clean', () => {
    // 4 / 8 === 0.5, the default. Strictly-above, so the boundary is not a coin
    // flip that flips a report on floating-point noise.
    expect(judgeLoad(4, 4, CPUS).contaminated).toBe(false);
  });

  it('applies half a CPU of load per core by default', () => {
    expect(DEFAULT_LOAD_PER_CPU_THRESHOLD).toBe(0.5);
    expect(judgeLoad(4.8, 0, CPUS).contaminated).toBe(true);
    expect(judgeLoad(3.2, 0, CPUS).contaminated).toBe(false);
  });

  it('honours a custom threshold', () => {
    // Identical readings, opposite verdicts — the option, not the input, is
    // what moved.
    expect(judgeLoad(2, 2, CPUS).contaminated).toBe(false);
    expect(judgeLoad(2, 2, CPUS, { maxLoadPerCpu: 0.1 }).contaminated).toBe(true);
  });

  it('normalises an impossible reading to null', () => {
    // `NaN` and `Infinity` both serialise to JSON `null`, so they are made
    // `null` here — otherwise the in-memory value and the value a reader sees
    // would state different facts about the same capture.
    const judged = judgeLoad(Number.NaN, Number.POSITIVE_INFINITY, CPUS);

    expect(judged.before).toBeNull();
    expect(judged.after).toBeNull();
    expect(judged.available).toBe(false);
    expect(judged.contaminated).toBe(false);
  });
});

describe('judgeLoad with unavailable load', () => {
  it('never reports unavailable load as contaminated', () => {
    expect(judgeLoad(null, null, CPUS).contaminated).toBe(false);
  });

  it('distinguishes unavailable load from a measured idle machine', () => {
    const unavailable = judgeLoad(null, null, CPUS);
    const measuredIdle = judgeLoad(0, 0, CPUS);

    // Same verdict — which is exactly why the verdict alone must not be the
    // only thing a reader looks at.
    expect(unavailable.contaminated).toBe(measuredIdle.contaminated);

    // The explicit tell...
    expect(unavailable.available).toBe(false);
    expect(measuredIdle.available).toBe(true);

    // ...and the readings themselves, for a reader holding nothing but the
    // JSON. `null` is not a number, so it cannot be misread as a measurement —
    // where the Windows `0` this guard exists to reject would have been.
    expect(unavailable.before).toBeNull();
    expect(unavailable.after).toBeNull();
    expect(measuredIdle.before).toBe(0);
    expect(measuredIdle.after).toBe(0);
  });

  it('still convicts on a single usable reading', () => {
    // The documented `available: false` + `contaminated: true` combination:
    // losing the second reading must not launder what the first one saw.
    const judged = judgeLoad(12, null, CPUS);

    expect(judged.available).toBe(false);
    expect(judged.contaminated).toBe(true);
    expect(judged.before).toBe(12);
    expect(judged.after).toBeNull();
  });

  it('clears the verdict but not availability when only the later reading survives', () => {
    // The mirror of the case above, and a second guard on "both readings are
    // consulted": here it is `after` alone that convicts.
    const judged = judgeLoad(null, 12, CPUS);

    expect(judged.available).toBe(false);
    expect(judged.contaminated).toBe(true);
  });

  it('refuses to judge when the CPU count is impossible', () => {
    // Dividing by zero would report `Infinity > threshold` — every such report
    // contaminated, on no evidence at all. `available` stays true because the
    // load itself *was* read; the schema rejects the body on `cpus` instead,
    // which is where a bogus CPU count belongs.
    const judged = judgeLoad(12, 12, 0);

    expect(judged.contaminated).toBe(false);
    expect(judged.available).toBe(true);
    expect(() => LoadSchema.parse(judged)).toThrow();
  });
});

describe('readLoad', () => {
  it('returns a plausible shape for whatever machine is running this', () => {
    // Deliberately tolerant: this reads the real machine, so it asserts
    // invariants and never values.
    const sample = readLoad();

    expect(Number.isInteger(sample.cpus)).toBe(true);
    expect(sample.cpus).toBeGreaterThanOrEqual(1);

    if (platform() === 'win32') {
      // The whole cross-platform point: Windows has no load average, and the
      // absent reading must not arrive as a plausible-looking zero.
      expect(sample.loadAvg1).toBeNull();
    } else {
      expect(sample.loadAvg1).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces readings judgeLoad can consume', () => {
    const sample = readLoad();
    const judged = judgeLoad(sample.loadAvg1, sample.loadAvg1, sample.cpus);

    expect(judged.cpus).toBe(sample.cpus);
    expect(judged.available).toBe(platform() !== 'win32');
    expect(() => LoadSchema.parse(judged)).not.toThrow();
  });
});
