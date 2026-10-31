/**
 * How one arm's repetitions fail, and what each carries: a step that exits otherwise than committed fails the measurement and the runner keeps going; a refused arm runs nothing.
 *
 * The per-repeat environment reaches only the measured runs, never the priming run.
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, a stand-in that logs its argv and environment into its
 * working directory.
 *
 * Integration-tier: every case spawns real child processes.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { runRepeats } from '../../src/harness/repeat.js';
import {
  cleanupProbes,
  PROBE_BASE_ENV,
  PROBE_FAIL_EXIT,
  PROBE_FAIL_TOKEN,
  PROBE_REPEAT_ENV,
  PROBE_STDERR_ENV,
  probeSpec,
  probeStep,
  setupProbe,
} from '../command-probe.js';

afterAll(cleanupProbes);
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-repeat-';

/** The value set for {@link PROBE_BASE_ENV}, asserted in every child's log line. */
const BASE_VALUE = 'base-value';

describe('runRepeats — failures and environments', () => {
  it('gives the measured run its per-repeat environment and the priming run only the base', async () => {
    const probe = setupProbe(PREFIX);

    await runRepeats(
      probeSpec(probe, {
        runs: 2,
        env: { [PROBE_BASE_ENV]: BASE_VALUE },
        envFor: (index) => ({ [PROBE_REPEAT_ENV]: `repeat-${String(index)}` }),
      }),
    );

    expect(probe.entries().map(({ base, perRepeat }) => ({ base, perRepeat }))).toEqual([
      { base: BASE_VALUE, perRepeat: null },
      { base: BASE_VALUE, perRepeat: 'repeat-0' },
      { base: BASE_VALUE, perRepeat: 'repeat-1' },
    ]);
  });

  it('keeps going after a failed cold repeat and reports every one, each a violation', async () => {
    const probe = setupProbe(PREFIX);

    const run = await runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 2, cache: 'cold' }));

    expect(run.results.map((sequenceRun) => sequenceRun.exitCode)).toEqual([PROBE_FAIL_EXIT, PROBE_FAIL_EXIT]);
    expect(run.results.map((sequenceRun) => sequenceRun.violation)).toEqual([
      `step 'boom' exited ${String(PROBE_FAIL_EXIT)}: probe was asked to fail`,
      `step 'boom' exited ${String(PROBE_FAIL_EXIT)}: probe was asked to fail`,
    ]);
  });

  it('fails a warm arm whose priming run exits otherwise than committed, and measures nothing', async () => {
    const probe = setupProbe(PREFIX);

    const run = await runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 3 }));

    expect(run.priming?.violation).toMatch(/^priming run: step 'boom' exited 3/);
    expect(run.results).toEqual([]);
    expect(probe.entries()).toHaveLength(1);
  });

  it('refuses a step that commits to exit 2', async () => {
    const probe = setupProbe(PREFIX);
    await expect(runRepeats(probeSpec(probe, { steps: [probeStep(['audit'], { expectedExit: 2 })] }))).rejects.toThrow(/exit 2/);
  });

  it('refuses a caller environment that names a variable the arm owns', async () => {
    const probe = setupProbe(PREFIX);
    await expect(runRepeats(probeSpec(probe, { env: { VAT_PROJECTION_STORE_DIR: probe.cwd } }))).rejects.toThrow(
      /VAT_PROJECTION_STORE_DIR/,
    );
  });

  it('captures every repetition\'s stderr per step', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 2, cache: 'cold' }));
    expect(run.results.map((sequenceRun) => sequenceRun.steps[0]?.stderr)).toEqual(['probe was asked to fail', 'probe was asked to fail']);
  });

  it('caps the stderr excerpt in a violation so one loud failure cannot swamp a report, keeping the whole stream on the step', async () => {
    const probe = setupProbe(PREFIX);
    const loud = 'x'.repeat(500);
    const run = await runRepeats(
      probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 1, cache: 'cold', env: { [PROBE_STDERR_ENV]: loud } }),
    );
    expect(run.results[0]?.violation).toBe(`step 'boom' exited ${String(PROBE_FAIL_EXIT)}: ${'x'.repeat(200)}`);
    expect(run.results[0]?.steps[0]?.stderr).toBe(loud);
  });
});
