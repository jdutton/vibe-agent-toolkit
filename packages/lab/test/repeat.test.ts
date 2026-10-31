/**
 * The repeat runner's pure parts: argument materialization, and the summary a
 * facet reports over a set of repetitions — arithmetic over exit codes and
 * violations, exercised on synthetic results rather than on spawned children.
 *
 * What a repetition actually runs is pinned in `integration/repeat-*.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { armRunFailure, materializeArgs, SUBJECT_TOKEN, summarizeRepeatFailures } from '../src/harness/repeat.js';
import type { SequenceResult } from '../src/harness/sequence.js';
import type { RunResult } from '../src/harness/types.js';

/**
 * Build a `RunResult` for the pure classification tests.
 *
 * @param overrides - The fields a case actually varies
 * @returns A complete result
 */
function result(overrides: Partial<RunResult> = {}): RunResult {
  return { wallMs: 1, exitCode: 0, stdout: '', stderr: '', spawnError: null, ...overrides };
}

/**
 * Build a `SequenceResult` for the summary tests.
 *
 * @param exitCode - Its aggregate exit code
 * @param violation - Why it fails the measurement, or `null`
 * @returns A complete result with no steps
 */
function sequence(exitCode: number, violation: string | null = null): SequenceResult {
  return { ...result({ exitCode }), steps: [], violation };
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

describe('summarizeRepeatFailures', () => {
  it('says nothing when every repeat completed with the same code', () => {
    expect(summarizeRepeatFailures([sequence(1), sequence(1), sequence(1)])).toBeNull();
  });

  it('counts the violations against the whole set', () => {
    expect(summarizeRepeatFailures([sequence(0), sequence(3, "step 'audit' exited 3: boom"), sequence(0)])).toBe(
      "1 of 3 repeats failed — step 'audit' exited 3: boom",
    );
  });

  it('fails a row whose repeats completed with DIFFERENT codes, naming both', () => {
    expect(summarizeRepeatFailures([sequence(0), sequence(1), sequence(0)])).toBe(
      '3 repeats exited 0 and 1 — every repeat completed, but not with the same amount of work ' +
        'done, so a statistic over them describes neither run',
    );
  });

  it('reports the violation, not the disagreement, when both are present', () => {
    expect(summarizeRepeatFailures([sequence(0), sequence(1), sequence(2, 'gone')])).toBe('1 of 3 repeats failed — gone');
  });

  it('says nothing about a set with no repeats — armRunFailure owns that case', () => {
    expect(summarizeRepeatFailures([])).toBeNull();
  });
});

describe('armRunFailure — the one rule every arm-measuring facet applies', () => {
  it('names a failed priming run first: a warm arm that never primed measured nothing', () => {
    expect(armRunFailure({ priming: sequence(3, "priming run: step 'audit' exited 3"), results: [] })).toBe(
      "priming failed — priming run: step 'audit' exited 3",
    );
  });

  it('then any repeat that failed, or repeats that disagree, in summarizeRepeatFailures’ words', () => {
    expect(armRunFailure({ priming: null, results: [sequence(0), sequence(3, 'gone')] })).toBe('1 of 2 repeats failed — gone');
  });

  it('then an arm with no repeats at all, which is no measurement', () => {
    expect(armRunFailure({ priming: sequence(0), results: [] })).toBe('no repeats were requested');
  });

  it('and nothing for an arm whose every repeat completed alike', () => {
    expect(armRunFailure({ priming: sequence(0), results: [sequence(0), sequence(0)] })).toBeNull();
  });
});
