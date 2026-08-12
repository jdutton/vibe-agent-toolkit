/**
 * The repeat runner is shared by every measurement facet, so a mistake here is a
 * wrong number in every report — the same stake `run.test.ts` opens with, one
 * level up.
 *
 * Three properties carry the weight, and each is pinned by a fixture that can
 * actually tell the two answers apart:
 *
 * 1. **Cold means cold on EVERY repeat.** The probe appends one line per
 *    child process, so the test reads an ORDERED sequence rather than a count:
 *    `[clear, run, clear, run, clear, run]`. An implementation that cleared once
 *    before the loop produces `[clear, run, run, run]` — same children, wrong
 *    shape, which a bare "was the cache cleared?" assertion would accept.
 * 2. **The per-repeat environment reaches the measured run and NOT the clear.**
 *    Every log line records both variables, so "the clear saw the per-repeat
 *    value" and "the clear never ran" are distinguishable outcomes rather than
 *    one silent absence.
 * 3. **A failed repeat still comes back.** `runRepeats` reports; it does not
 *    filter. The rule that a failure must not be timed lives one layer up, in
 *    the facet, and this suite exists partly to keep that boundary visible —
 *    `perf-capture.test.ts` pins the other side of that boundary with the same
 *    probe.
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, a stand-in that logs its argv and the two environment
 * variables into its working directory — which is also why no test asserts the
 * cwd directly: the log file only appears under the temp dir at all if `cwd` was
 * honoured.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  classifyRunFailure,
  materializeArgs,
  runRepeats,
  SUBJECT_TOKEN,
} from '../src/harness/repeat.js';
import type { RunResult } from '../src/harness/types.js';

import { cleanupProbes, PROBE_BASE_ENV, PROBE_FAIL_EXIT, PROBE_FAIL_TOKEN, PROBE_REPEAT_ENV, probeSpec, setupProbe } from './command-probe.js';

afterAll(cleanupProbes);

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-repeat-';

/** The value set for {@link PROBE_BASE_ENV}, asserted in every child's log line. */
const BASE_VALUE = 'base-value';

/**
 * Build a `RunResult` for the pure classification tests.
 *
 * @param overrides - The fields a case actually varies
 * @returns A complete result
 */
function result(overrides: Partial<RunResult> = {}): RunResult {
  return { wallMs: 1, exitCode: 0, stdout: '', stderr: '', spawnError: null, ...overrides };
}

describe('materializeArgs', () => {
  it('substitutes EVERY occurrence of the subject token, in every argument', () => {
    // Two tokens in one string on purpose: an implementation using `replace`
    // rather than `replaceAll` passes a one-token fixture and fails this one.
    const args = materializeArgs(
      ['audit', SUBJECT_TOKEN, `${SUBJECT_TOKEN}/a/${SUBJECT_TOKEN}`],
      '/p',
    );

    expect(args).toEqual(['audit', '/p', '/p/a//p']);
  });

  it('leaves arguments without the token exactly as they were', () => {
    expect(materializeArgs(['audit', '--json'], '/p')).toEqual(['audit', '--json']);
  });
});

describe('classifyRunFailure', () => {
  it('calls a clean exit no failure', () => {
    expect(classifyRunFailure(result())).toBeNull();
  });

  it('reports a spawn failure IN PREFERENCE to any exit code', () => {
    // A process that never ran has no exit code worth reporting. The fixture
    // supplies both, so a classifier testing them in the wrong order returns
    // the 'exited 3' string and fails here.
    const failure = classifyRunFailure(result({ exitCode: 3, spawnError: 'ENOENT: no such file' }));

    expect(failure).toBe('ENOENT: no such file');
  });

  it('reports a non-zero exit with the code and the start of stderr', () => {
    const failure = classifyRunFailure(result({ exitCode: 3, stderr: '  no config found\n' }));

    expect(failure).toBe('exited 3: no config found');
  });

  it('caps the stderr excerpt so one loud failure cannot swamp a report', () => {
    const failure = classifyRunFailure(result({ exitCode: 1, stderr: 'x'.repeat(500) }));

    expect(failure).toBe(`exited 1: ${'x'.repeat(200)}`);
  });
});

describe('runRepeats', () => {
  it('runs the command once per repeat and returns every result', () => {
    const probe = setupProbe(PREFIX);

    const results = runRepeats(probeSpec(probe, { runs: 3 }));

    expect(results).toHaveLength(3);
    expect(results.every((run) => run.exitCode === 0)).toBe(true);
    expect(probe.entries().map((entry) => entry.args)).toEqual([['audit'], ['audit'], ['audit']]);
  });

  it('clears the cache before EVERY cold repeat, not once before the loop', () => {
    const probe = setupProbe(PREFIX);

    runRepeats(probeSpec(probe, { runs: 3, cache: 'cold' }));

    // The ordered sequence is the assertion. Clearing once yields
    // [clear, audit, audit, audit], which is the mutant this pins.
    expect(probe.entries().map((entry) => entry.args)).toEqual([
      ['cache', 'clear'],
      ['audit'],
      ['cache', 'clear'],
      ['audit'],
      ['cache', 'clear'],
      ['audit'],
    ]);
  });

  it('never clears the cache when the mode is warm', () => {
    const probe = setupProbe(PREFIX);

    runRepeats(probeSpec(probe, { runs: 2 }));

    expect(probe.entries().map((entry) => entry.args)).toEqual([['audit'], ['audit']]);
  });

  it('spawns nothing at all when no repeats were requested, even cold', () => {
    // The same mutant from the other side: a clear hoisted out of the loop still
    // fires here, where nothing at all should run.
    const probe = setupProbe(PREFIX);

    const results = runRepeats(probeSpec(probe, { runs: 0, cache: 'cold' }));

    expect(results).toEqual([]);
    expect(probe.entries()).toEqual([]);
  });

  it('gives the measured run its per-repeat environment and the clear only the base', () => {
    const probe = setupProbe(PREFIX);

    runRepeats(
      probeSpec(probe, {
        runs: 2,
        cache: 'cold',
        env: { [PROBE_BASE_ENV]: BASE_VALUE },
        envFor: (index) => ({ [PROBE_REPEAT_ENV]: `repeat-${String(index)}` }),
      }),
    );

    // Both variables are recorded by every child, so "the clear saw the
    // per-repeat value" and "the clear never ran" are different outcomes here.
    expect(probe.entries()).toEqual([
      { args: ['cache', 'clear'], base: BASE_VALUE, perRepeat: null },
      { args: ['audit'], base: BASE_VALUE, perRepeat: 'repeat-0' },
      { args: ['cache', 'clear'], base: BASE_VALUE, perRepeat: null },
      { args: ['audit'], base: BASE_VALUE, perRepeat: 'repeat-1' },
    ]);
  });

  it('keeps going after a failed repeat and reports it raw, unfiltered', () => {
    // Deciding what a failure means belongs to the facet. If this ever started
    // short-circuiting, a facet's "any failure poisons the row" rule would be
    // handed a shorter list than it asked for and would under-report.
    const probe = setupProbe(PREFIX);

    const results = runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 2 }));

    expect(results).toHaveLength(2);
    expect(results.map((run) => run.exitCode)).toEqual([PROBE_FAIL_EXIT, PROBE_FAIL_EXIT]);
    expect(results.every((run) => run.spawnError === null)).toBe(true);
    expect(probe.entries()).toHaveLength(2);
  });
});
