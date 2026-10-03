/**
 * The comparison render never lets an unmeasured row read as "no change", and
 * says FAILED whenever the compare exits non-zero.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import type { VerdictComparison } from '../src/facets/verdict/compare.js';
import type { DeclaredDelta, ObservedDelta } from '../src/facets/verdict/deltas.js';
import { locationDigest, UNCODED_REFUSAL } from '../src/facets/verdict/extract.js';
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
    excluded: [],
    staleExclusions: [],
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

  const EXCLUDED_ROW = {
    subject: 'crucible-1',
    verb: 'build',
    reason: 'needs an artifact the subject has not built',
    detail: [`baseline: exit 2, refusal ${UNCODED_REFUSAL}`, 'candidate: exit 2, refusal RUN_INCOMPLETE, claude:RUN_INCOMPLETE'],
  };

  it('names every excluded verb with its reason and what each arm did, and counts them in the verdict line', () => {
    const text = renderVerdictComparison(comparison({ excluded: [EXCLUDED_ROW], rows: [] }));

    expect(text).toContain('EXCLUDED by the subjects file');
    expect(text).toContain('crucible-1 / build: needs an artifact the subject has not built');
    expect(text).toContain('    candidate: exit 2, refusal RUN_INCOMPLETE, claude:RUN_INCOMPLETE');
    expect(text).toContain('PASSED (0 undeclared, 0 unused, 0 accepted; 1 excluded)');
  });

  it('says FAILED on a stale exclusion, naming the arm that measured the verb', () => {
    const stale = { ...EXCLUDED_ROW, detail: ['baseline MEASURED it: exit 0', 'candidate MEASURED it: exit 0'] };
    const text = renderVerdictComparison(comparison({ staleExclusions: [stale], rows: [], exitCode: ExitCode.FINDINGS }));

    expect(text).toContain('STALE EXCLUSION');
    expect(text).toContain('    candidate MEASURED it: exit 0');
    expect(text).toContain('FAILED (0 undeclared, 0 unused, 0 accepted; 1 stale exclusion(s))');
    expect(text).not.toContain('EXCLUDED by the subjects file');
  });

  it('renders an itemized-findings delta in words', () => {
    const itemized: ObservedDelta = {
      subject: 'crucible-1',
      verb: 'verify',
      change: { kind: 'findings-itemized' },
      detail: ['baseline published 2 of 3 finding(s) only as per-code tallies'],
    };
    const text = renderVerdictComparison(comparison({ accepted: [itemized] }));

    expect(text).toContain('crucible-1 / verify: findings itemized (exactly the findings the baseline only tallied)');
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

  it('renders an unused digest declaration by its digest, and an observed finding with the digest to declare it by', () => {
    const digest = 'a'.repeat(64);
    const declared: DeclaredDelta = {
      subject: 'crucible-1',
      verb: 'verify',
      change: { kind: 'finding-added', finding: { code: 'FILES_CONFIG_DEST_MISSING', severity: 'error', locationDigest: digest, scope: null } },
      changelog: 'v020-report-contract',
      reason: 'one finding per missing dest',
    };
    const added: ObservedDelta = {
      subject: 'crucible-1',
      verb: 'verify',
      change: { kind: 'finding-added', finding: { code: 'FILES_CONFIG_DEST_MISSING', severity: 'error', location: 'dist/a.bin', scope: null } },
      detail: [],
    };
    const text = renderVerdictComparison(comparison({ unused: [declared], undeclared: [added], exitCode: ExitCode.FINDINGS }));

    expect(text).toContain(`crucible-1 / verify: + error FILES_CONFIG_DEST_MISSING @ sha256:${digest} (v020-report-contract)`);
    expect(text).toContain(`crucible-1 / verify: + error FILES_CONFIG_DEST_MISSING @ dist/a.bin [locationDigest ${locationDigest('dist/a.bin')}]`);
  });

  it('renders a refusal move with both arms\' codes', () => {
    const moved: ObservedDelta = {
      subject: 'crucible-1',
      verb: 'build',
      change: { kind: 'refusal', from: [], to: ['RUN_INCOMPLETE', 'claude:RUN_INCOMPLETE'] },
      detail: [],
    };

    expect(renderVerdictComparison(comparison({ accepted: [moved] }))).toContain(
      'crucible-1 / build: refusal (no refusal published) → RUN_INCOMPLETE, claude:RUN_INCOMPLETE',
    );
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
          { name: 'build', argv: ['build'], outcome: 'exited', exitCode: 2, spawnError: null, document: '' },
        ],
        excluded: [{ name: 'build', reason: 'needs an artifact the subject has not built' }],
      },
    } as unknown as ReportEnvelope<VerdictBody>;

    const text = renderVerdictReport(envelope);

    expect(text).toContain('verdict — crucible-1');
    expect(text).toContain('  audit: exit 0');
    expect(text).toContain('  verify: NOT RUN — ETIMEDOUT');
    expect(text).toContain('  build: exit 2');
    expect(text).toContain('  build: EXCLUDED (it still ran — see its row) — needs an artifact the subject has not built');
  });
});
