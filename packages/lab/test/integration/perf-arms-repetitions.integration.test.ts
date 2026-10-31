/**
 * What each `captureArms` repetition records: every step's exit, stderr and
 * provenance, the environment names the arm's VAT steps did not receive, a
 * warm arm's priming run — and the failure of an arm whose step exits
 * otherwise than committed, which fails that arm only.
 *
 * Integration-tier: every case spawns the shared probe.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

import { captureArms } from '../../src/facets/perf/arms.js';
import { cleanupProbes, PROBE_FAIL_AT_ENV, PROBE_STDOUT_ENV, probeStep, setupProbe } from '../command-probe.js';

import { armsRequest, PASSING_AND_FAILING_ARMS } from './perf-arms-request.js';

afterAll(cleanupProbes);

const PREFIX = 'lab-perf-arms-repetitions-';

describe('captureArms — what each repetition records', () => {
  it('records every step’s exit, stderr and provenance, and the removed environment names', async () => {
    const probe = setupProbe(PREFIX);
    vi.stubEnv('VAT_LAB_ARMS_PLANTED', 'leak');
    try {
      const document = JSON.stringify({
        status: 'success',
        examined: 1,
        findings: [],
        summary: {},
        data: { population: 'derived' },
      });
      const report = await captureArms(
        armsRequest(probe, {
          rounds: 1,
          arms: [
            {
              build: 'old',
              arm: 'B',
              state: 'cold',
              steps: [probeStep(['check'], { provenance: 'resources-check' }), probeStep(['skills'])],
            },
          ],
          env: { set: { [PROBE_STDOUT_ENV]: JSON.stringify([document]) }, unset: [] },
        }),
      );

      const [arm] = report.arms;
      expect(arm?.removedEnv).toContain('VAT_LAB_ARMS_PLANTED');
      // A tool step runs without VAT_* too, and the report says so separately.
      expect(arm?.removedToolEnv).toContain('VAT_LAB_ARMS_PLANTED');
      const [repetition] = arm?.repetitions ?? [];
      expect(repetition?.steps.map((step) => [step.name, step.exitCode, step.timed])).toEqual([
        ['check', 0, true],
        ['skills', 0, true],
      ]);
      expect(repetition?.steps[0]?.provenance).toEqual({ resources: 'derived', checks: null, lens: null });
      expect(repetition?.steps[1]?.provenance).toBeNull();
      expect(repetition?.steps.map((step) => step.stderr)).toEqual(['', '']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails an arm whose step exits otherwise than committed, and only that arm', async () => {
    const probe = setupProbe(PREFIX);

    const report = await captureArms(
      armsRequest(probe, {
        arms: PASSING_AND_FAILING_ARMS,
      }),
    );

    const [passing, failing] = report.arms;
    expect(passing?.failure).toBeNull();
    expect(failing?.summary).toBeNull();
    expect(failing?.failure).toMatch(/^3 of 3 repeats failed — step 'boom' exited 3: /u);
    expect(failing?.repetitions.map((repetition) => repetition.steps[0]?.stderr)).toEqual([
      'probe was asked to fail',
      'probe was asked to fail',
      'probe was asked to fail',
    ]);
  });

  it('reports a warm arm’s priming run, and fails the arm when priming failed', async () => {
    const probe = setupProbe(PREFIX);

    const report = await captureArms(
      armsRequest(probe, {
        rounds: 2,
        arms: [{ build: 'old', arm: 'A', state: 'warm', steps: [probeStep(['a'])] }],
        env: { set: { [PROBE_FAIL_AT_ENV]: '0' }, unset: [] },
      }),
    );

    const [arm] = report.arms;
    expect(arm?.priming?.violation).toMatch(/^priming run: step 'a' exited 3/u);
    expect(arm?.repetitions).toEqual([]);
    expect(arm?.summary).toBeNull();
    expect(arm?.failure).toMatch(/^priming failed — priming run: /u);
  });
});
