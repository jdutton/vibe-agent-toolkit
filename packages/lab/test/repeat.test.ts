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
 * The two pure classifiers are exercised on synthetic `RunResult`s rather than
 * on spawned children, because what they decide is arithmetic over exit codes:
 * whether a code means the run COMPLETED (the command declares that), and
 * whether the repeats agreed on which of the accepted codes they produced.
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
  summarizeRepeatFailures,
} from '../src/harness/repeat.js';
import type { RunResult } from '../src/harness/types.js';

import { cleanupProbes, PROBE_BASE_ENV, PROBE_FAIL_EXIT, PROBE_FAIL_TOKEN, PROBE_REPEAT_ENV, probeSpec, setupProbe } from './command-probe.js';

afterAll(cleanupProbes);

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-repeat-';

/** The value set for {@link PROBE_BASE_ENV}, asserted in every child's log line. */
const BASE_VALUE = 'base-value';

/** What a command that only completes at 0 accepts. */
const ONLY_ZERO: readonly number[] = [0];

/** What a findings command accepts: 0 (nothing to report) and 1 (findings). */
const ZERO_OR_FINDINGS: readonly number[] = [0, 1];

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
 * A set of repeats that each exited with the given code and nothing else.
 *
 * @param codes - One exit code per repeat, in order
 * @returns The results, ready for {@link summarizeRepeatFailures}
 */
function resultsExiting(...codes: readonly number[]): RunResult[] {
  return codes.map((exitCode) => result({ exitCode }));
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
    expect(classifyRunFailure(result(), ONLY_ZERO)).toBeNull();
  });

  it('reports a spawn failure IN PREFERENCE to any exit code', () => {
    // A process that never ran has no exit code worth reporting. The fixture
    // supplies both, so a classifier testing them in the wrong order returns
    // the 'exited 3' string and fails here.
    const failure = classifyRunFailure(
      result({ exitCode: 3, spawnError: 'ENOENT: no such file' }),
      ONLY_ZERO,
    );

    expect(failure).toBe('ENOENT: no such file');
  });

  it('reports a spawn failure even when the exit code it carries is an ACCEPTED one', () => {
    // The ordering guarantee where it actually bites now that codes can be
    // accepted: a classifier that consulted `completedExitCodes` before
    // `spawnError` would return null here and admit a process that never ran
    // into a median.
    const failure = classifyRunFailure(
      result({ exitCode: 1, spawnError: 'killed after timeout' }),
      ZERO_OR_FINDINGS,
    );

    expect(failure).toBe('killed after timeout');
  });

  it('reports a non-zero exit with the code and the start of stderr', () => {
    const failure = classifyRunFailure(
      result({ exitCode: 3, stderr: '  no config found\n' }),
      ONLY_ZERO,
    );

    expect(failure).toBe('exited 3: no config found');
  });

  it('treats a code the command declared as completed as no failure at all', () => {
    // The defect this replaces: `vat validate` exits 1 on any project with
    // findings, which is every real project, so its every repeat was a
    // "failure" and its row could never carry a number.
    expect(classifyRunFailure(result({ exitCode: 1 }), ZERO_OR_FINDINGS)).toBeNull();
  });

  it('still fails the same exit 1 when the command did NOT declare it completed', () => {
    // The pair to the case above, on the identical result: only the accepted
    // set differs, so the fixture can genuinely tell the two answers apart.
    const failure = classifyRunFailure(result({ exitCode: 1, stderr: 'broken' }), ONLY_ZERO);

    expect(failure).toBe('exited 1: broken');
  });

  it('never accepts exit 2 — a system error is a run that did not complete', () => {
    const failure = classifyRunFailure(
      result({ exitCode: 2, stderr: 'no config found' }),
      ZERO_OR_FINDINGS,
    );

    expect(failure).toBe('exited 2: no config found');
  });

  it('fails a run with no exit code at all, whatever is accepted', () => {
    expect(classifyRunFailure(result({ exitCode: null }), ZERO_OR_FINDINGS)).toBe('exited null: ');
  });

  it('caps the stderr excerpt so one loud failure cannot swamp a report', () => {
    const failure = classifyRunFailure(result({ exitCode: 1, stderr: 'x'.repeat(500) }), ONLY_ZERO);

    expect(failure).toBe(`exited 1: ${'x'.repeat(200)}`);
  });
});

describe('summarizeRepeatFailures', () => {
  it('says nothing when every repeat exited with the same accepted code', () => {
    expect(summarizeRepeatFailures(resultsExiting(1, 1, 1), ZERO_OR_FINDINGS)).toBeNull();
  });

  it('counts the failures against the whole set', () => {
    const failure = summarizeRepeatFailures(
      [result(), result({ exitCode: 3, stderr: 'boom' }), result()],
      ONLY_ZERO,
    );

    expect(failure).toBe('1 of 3 repeats failed — exited 3: boom');
  });

  it('fails a row whose repeats exited with DIFFERENT accepted codes, naming both', () => {
    // Nothing failed: 0 and 1 are both completed runs for this command. But one
    // repeat found something to report and the other did not, so they did
    // different amounts of work and a median over them describes neither.
    const failure = summarizeRepeatFailures(resultsExiting(0, 1, 0), ZERO_OR_FINDINGS);

    expect(failure).toBe(
      '3 repeats exited 0 and 1 — every repeat completed, but not with the same amount of work ' +
        'done, so a statistic over them describes neither run',
    );
  });

  it('reports the outright failure, not the disagreement, when both are present', () => {
    // A set that is non-uniform AND has a real failure in it: the failure is
    // the more actionable thing to say, and saying both would be two sentences
    // for one row.
    const failure = summarizeRepeatFailures(
      [result({ exitCode: 0 }), result({ exitCode: 1 }), result({ exitCode: 2, stderr: 'gone' })],
      ZERO_OR_FINDINGS,
    );

    expect(failure).toBe('1 of 3 repeats failed — exited 2: gone');
  });

  it('says nothing about a set with no repeats — that is the facet\'s own case', () => {
    expect(summarizeRepeatFailures([], ONLY_ZERO)).toBeNull();
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
