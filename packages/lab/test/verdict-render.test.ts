/**
 * The comparison render never lets an unmeasured row read as "no change", and
 * says FAILED whenever the compare exits non-zero.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { VerdictComparison } from '../src/facets/verdict/compare.js';
import type { ObservedDelta } from '../src/facets/verdict/deltas.js';
import { renderVerdictComparison } from '../src/facets/verdict/render.js';

import { PROBE_VERSION } from './command-probe.js';

const UNMEASURED: ObservedDelta = {
  subject: 'crucible-1',
  verb: 'audit',
  change: { kind: 'unmeasured' },
  detail: ['baseline exited 2 (the command could not do its job)'],
};

/**
 * @param overrides - What the case varies
 * @returns A comparison over one row
 */
function comparison(overrides: Partial<VerdictComparison>): VerdictComparison {
  return {
    ok: true,
    baseline: PROBE_VERSION,
    candidate: { ...PROBE_VERSION, closure: 'b'.repeat(64) },
    control: false,
    rows: [{ subject: 'crucible-1', verb: 'audit', baselineExit: 2, candidateExit: 2, observed: [UNMEASURED] }],
    accepted: [],
    undeclared: [],
    unused: [],
    refusals: [],
    exitCode: ExitCode.OK,
    ...overrides,
  };
}

describe('renderVerdictComparison', () => {
  it('lists a declared unmeasured row as UNMEASURED, with its reason', () => {
    const text = renderVerdictComparison(comparison({ accepted: [UNMEASURED] }));

    expect(text).toContain('UNMEASURED (declared)');
    expect(text).toContain('baseline exited 2');
    expect(text).toContain('PASSED (0 undeclared, 0 unused, 1 accepted)');
  });

  it('says FAILED on an undeclared delta', () => {
    const text = renderVerdictComparison(comparison({ undeclared: [UNMEASURED], exitCode: ExitCode.FINDINGS }));

    expect(text).toContain('UNDECLARED');
    expect(text).toContain('FAILED (1 undeclared, 0 unused, 0 accepted)');
  });
});
