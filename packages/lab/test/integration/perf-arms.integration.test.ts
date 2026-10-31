/**
 * `captureArms` runs several (build, arm, state) arms INTERLEAVED by round and
 * reports min/median/IQR per arm — or the failure that means there is no time
 * at all — and `renderArmsReport` prints each. What one repetition records:
 * `perf-arms-repetitions.integration.test.ts`.
 *
 * The instrument is the shared probe: it logs each child's argv into its cwd, so
 * the round order is read straight off the log.
 *
 * Integration-tier: every case spawns real child processes.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { captureArms, renderArmsReport } from '../../src/facets/perf/arms.js';
import { argsOf, cleanupProbes, probeStep, setupProbe } from '../command-probe.js';

import { armsRequest, PASSING_AND_FAILING_ARMS } from './perf-arms-request.js';

afterAll(cleanupProbes);

const PREFIX = 'lab-perf-arms-';

describe('captureArms — rounds', () => {
  it('interleaves the arms by round, never as sequential blocks', async () => {
    const probe = setupProbe(PREFIX);

    await captureArms(armsRequest(probe));

    expect(argsOf(probe.entries())).toEqual([['a'], ['c'], ['a'], ['c'], ['a'], ['c']]);
  });

  it('reports min, median and IQR per arm over its measured rounds', async () => {
    const probe = setupProbe(PREFIX);

    const report = await captureArms(armsRequest(probe));

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

  it("records every arm step's exact commitment and the code its rounds shared", async () => {
    const probe = setupProbe(PREFIX);

    const report = await captureArms(armsRequest(probe));

    expect(report.arms.map((arm) => arm.exits)).toEqual([
      [{ step: 'a', commitment: { kind: 'exact', code: 0 }, observed: 0 }],
      [{ step: 'c', commitment: { kind: 'exact', code: 0 }, observed: 0 }],
    ]);
  });

  it('refuses an arm naming a build it was not given', async () => {
    const probe = setupProbe(PREFIX);

    await expect(
      captureArms(armsRequest(probe, { arms: [{ build: 'nonesuch', arm: 'A', state: 'cold', steps: [probeStep(['a'])] }] })),
    ).rejects.toThrow(/build 'nonesuch'/u);
    expect(probe.entries()).toEqual([]);
  });
});

describe('renderArmsReport', () => {
  it('prints a measured arm’s statistics and a failed arm’s reason, one line each', async () => {
    const probe = setupProbe(PREFIX);
    const report = await captureArms(
      armsRequest(probe, {
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
