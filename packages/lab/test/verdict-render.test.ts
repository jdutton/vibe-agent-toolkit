/**
 * The comparison render never lets an unmeasured row read as "no change", and
 * says FAILED whenever the compare exits non-zero.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import type { VerdictComparison } from '../src/facets/verdict/compare.js';
import type { DeclaredDelta, ObservedDelta } from '../src/facets/verdict/deltas.js';
import { renderVerdictComparison, renderVerdictReport } from '../src/facets/verdict/render.js';
import type { VerdictBody } from '../src/facets/verdict/types.js';

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

describe('renderVerdictComparison — an unused declaration', () => {
  it('names the declared change and the changelog entry that claimed it', () => {
    const declared: DeclaredDelta = {
      subject: 'crucible-1',
      verb: 'build',
      change: { kind: 'exit', from: 0, to: 1 },
      changelog: 'v020-report-contract',
      reason: 'an empty build now fails',
    };
    const text = renderVerdictComparison(comparison({ unused: [declared], exitCode: ExitCode.FINDINGS }));

    expect(text).toContain('UNUSED');
    expect(text).toContain('crucible-1 / build: exit 0 → 1 (v020-report-contract)');
    expect(text).toContain('FAILED (0 undeclared, 1 unused, 0 accepted)');
  });
});

describe('renderVerdictReport', () => {
  it('prints one line per row: an exit code, or NOT RUN with its spawn error', () => {
    const envelope = {
      facet: 'verdict',
      capturedAt: '2026-10-03T00:00:00.000Z',
      coordinate: {
        subject: { id: 'crucible-1', source: '/work/tree' },
        subjectVersion: { kind: 'git', commit: 'a'.repeat(40), ref: 'main', dirty: false, workingFingerprint: null },
        instrument: PROBE_VERSION,
      },
      body: {
        rows: [
          { name: 'audit', argv: ['audit'], outcome: 'exited', exitCode: 0, spawnError: null, document: '' },
          { name: 'verify', argv: ['verify'], outcome: 'not-run', exitCode: null, spawnError: 'ETIMEDOUT', document: '' },
        ],
      },
    } as unknown as ReportEnvelope<VerdictBody>;

    const text = renderVerdictReport(envelope);

    expect(text).toContain('verdict — crucible-1');
    expect(text).toContain('  audit: exit 0');
    expect(text).toContain('  verify: NOT RUN — ETIMEDOUT');
  });
});
