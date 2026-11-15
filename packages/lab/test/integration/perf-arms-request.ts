/**
 * The request every `captureArms` integration file starts from: two builds of
 * the one shared probe instrument, two cold arms, three rounds.
 */

import type { ArmSelection, CaptureArmsRequest } from '../../src/facets/perf/arms.js';
import { PROBE_FAIL_TOKEN, probeArmsRoot, probeStep, type Probe } from '../command-probe.js';

/**
 * A request against a probe with two builds of the one probe instrument.
 *
 * @param probe - The stand-in vat
 * @param overrides - What the case varies
 * @returns The request
 */
export function armsRequest(probe: Probe, overrides: Partial<CaptureArmsRequest> = {}): CaptureArmsRequest {
  return {
    armsRoot: probeArmsRoot(probe),
    cwd: probe.cwd,
    builds: [
      { alias: 'old', source: { kind: 'dist', path: probe.cwd }, instrument: probe.instrument },
      { alias: 'new', source: { kind: 'dist', path: probe.cwd }, instrument: probe.instrument },
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
export const PASSING_AND_FAILING_ARMS: readonly ArmSelection[] = [
  { build: 'old', arm: 'A', state: 'cold', steps: [probeStep(['a'])] },
  { build: 'new', arm: 'C', state: 'cold', steps: [probeStep([PROBE_FAIL_TOKEN])] },
];
