/**
 * `captureArms` runs several (build, arm, state) arms INTERLEAVED by round and
 * reports, per arm, every repetition's step exits, stderr and provenance, the
 * environment names the arm's VAT steps did not receive, and min/median/IQR —
 * or the failure that means there is no time at all.
 *
 * The instrument is the shared probe: it logs each child's argv into its cwd, so
 * the round order is read straight off the log.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

import { type ArmSelection, captureArms, type CaptureArmsRequest, renderArmsReport, sequenceSteps } from '../src/facets/perf/arms.js';
import { MEASURABLE_SEQUENCES } from '../src/harness/commands.js';

import {
  argsOf,
  cleanupProbes,
  PROBE_FAIL_AT_ENV,
  PROBE_FAIL_TOKEN,
  PROBE_STDOUT_ENV,
  probeOut,
  probeStep,
  setupProbe,
  type Probe,
} from './command-probe.js';

afterAll(cleanupProbes);

const PREFIX = 'lab-perf-arms-';

/**
 * A request against a probe with two builds of the one probe instrument.
 *
 * @param probe - The stand-in vat
 * @param overrides - What the case varies
 * @returns The request
 */
function request(probe: Probe, overrides: Partial<CaptureArmsRequest> = {}): CaptureArmsRequest {
  return {
    out: probeOut(probe),
    cwd: probe.cwd,
    builds: [
      { alias: 'old', instrument: probe.instrument },
      { alias: 'new', instrument: probe.instrument },
    ],
    arms: [
      { build: 'old', arm: 'A', state: 'cold', steps: [probeStep(['a'])] },
      { build: 'new', arm: 'C', state: 'cold', steps: [probeStep(['c'])] },
    ],
    rounds: 3,
    env: { set: {}, unset: [] },
    ...overrides,
  };
}

/** Two cold arms on two builds: one completes, the other's step exits 3 (not committed). */
const PASSING_AND_FAILING_ARMS: readonly ArmSelection[] = [
  { build: 'old', arm: 'A', state: 'cold', steps: [probeStep(['a'])] },
  { build: 'new', arm: 'C', state: 'cold', steps: [probeStep([PROBE_FAIL_TOKEN])] },
];

describe('captureArms — rounds', () => {
  it('interleaves the arms by round, never as sequential blocks', async () => {
    const probe = setupProbe(PREFIX);

    await captureArms(request(probe));

    expect(argsOf(probe.entries())).toEqual([['a'], ['c'], ['a'], ['c'], ['a'], ['c']]);
  });

  it('reports min, median and IQR per arm over its measured rounds', async () => {
    const probe = setupProbe(PREFIX);

    const report = await captureArms(request(probe));

    expect(report.rounds).toBe(3);
    for (const arm of report.arms) {
      expect(arm.failure).toBeNull();
      expect(arm.repetitions).toHaveLength(3);
      const samples = arm.repetitions.map((repetition) => repetition.wallMs).sort((x, y) => x - y);
      expect(arm.summary?.minMs).toBe(samples[0]);
      expect(arm.summary?.medianMs).toBe(samples[1]);
      expect(arm.summary?.iqrMs).toBeGreaterThanOrEqual(0);
    }
    expect(report.arms.map((arm) => [arm.build, arm.arm, arm.state])).toEqual([
      ['old', 'A', 'cold'],
      ['new', 'C', 'cold'],
    ]);
  });

  it('refuses an arm naming a build it was not given', async () => {
    const probe = setupProbe(PREFIX);

    await expect(
      captureArms(request(probe, { arms: [{ build: 'nonesuch', arm: 'A', state: 'cold', steps: [probeStep(['a'])] }] })),
    ).rejects.toThrow(/build 'nonesuch'/u);
    expect(probe.entries()).toEqual([]);
  });
});

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
        request(probe, {
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
      request(probe, {
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
      request(probe, {
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

describe('renderArmsReport', () => {
  it('prints a measured arm’s statistics and a failed arm’s reason, one line each', async () => {
    const probe = setupProbe(PREFIX);
    const report = await captureArms(
      request(probe, {
        rounds: 1,
        arms: PASSING_AND_FAILING_ARMS,
      }),
    );

    const lines = renderArmsReport(report).split('\n');

    expect(lines[0]).toContain('1 interleaved rounds');
    expect(lines[1]).toMatch(/^old A cold: min [\d.]+ms {2}median [\d.]+ms {2}IQR [\d.]+ms {2}\(1 rounds\)$/u);
    expect(lines[2]).toMatch(/^new C cold: FAILED — 1 of 1 repeats failed — step 'boom' exited 3/u);
  });
});

describe('sequenceSteps', () => {
  it('turns a CI sequence into timed steps carrying each command’s exits and reader', () => {
    const steps = sequenceSteps(MEASURABLE_SEQUENCES['ci-b']);

    expect(steps.map((step) => [step.name, step.command, step.timed, step.expectedExits, step.provenance])).toEqual([
      ['resources-validate-ci', { kind: 'vat', args: ['resources', 'validate'] }, true, [0], 'none'],
      ['resources-check-ci', { kind: 'vat', args: ['resources', 'check'] }, true, [0], 'resources-check'],
      ['skills-validate-ci', { kind: 'vat', args: ['skills', 'validate'] }, true, [0], 'none'],
    ]);
  });
});
