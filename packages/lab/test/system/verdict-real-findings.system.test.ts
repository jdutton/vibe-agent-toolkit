/**
 * Bar 3's union key over REAL findings: a subject with one broken link, run
 * through CI's sequence (`resources validate --format json`, `resources check`,
 * `skills validate`) and the candidate's one `validate`, by the built vat.
 *
 * Every document must parse — an unreadable one would read as "no findings"
 * and make coverage vacuous — and the broken link must carry ONE union key
 * `(code, location, line, severity)` whichever verb reported it. A verb that
 * spelled the location or line its own way would fail bar 3 on a finding both
 * sides really share.
 *
 * System-tier: real git, the built vat, each verb in a cleared environment with
 * its own store, tmp and home under the arms root.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { captureVerdict } from '../../src/facets/verdict/capture.js';
import { rowLinedFindings } from '../../src/facets/verdict/extract.js';
import { unionFindings } from '../../src/facets/verdict/union.js';
import type { VerdictVerbName } from '../../src/facets/verdict/verbs.js';
import { cleanupVerdictFixtures, FIXTURE_ALIAS, tempDir } from '../integration/verdict-fixtures.js';

import { brokenLinkSubject, CANDIDATE_VAT } from './candidate-subject.js';

/** CI's sequence B, the left side of bar 3. */
const B: readonly VerdictVerbName[] = ['resources-validate-ci', 'resources-check-ci', 'skills-validate-ci'];

afterAll(cleanupVerdictFixtures);

describe('bar 3 over a subject with a real finding', () => {
  it('parses every document and gives the broken link one union key in B and in validate', async () => {
    const root = brokenLinkSubject();

    const result = await captureVerdict({
      instrument: CANDIDATE_VAT,
      subjects: [{ alias: FIXTURE_ALIAS, path: root, verbs: [...B, 'validate'], sqlFiles: [], buildVerbs: false, unmeasurableBuildVerbs: {} }],
      subjectsDir: root,
      env: { set: {}, unset: [] },
      prepared: {},
      outDir: tempDir('lab-verdict-findings-out-'),
      armsRoot: tempDir('lab-verdict-findings-arms-'),
      capturedAt: new Date().toISOString(),
    });

    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
    const body = result.envelopes[0]?.body;
    if (body === undefined) throw new Error('no envelope');
    // Every verb completed and printed a document the lab reads.
    for (const row of body.rows) {
      expect([row.name, row.outcome, row.exitCode === 0 || row.exitCode === 1]).toEqual([row.name, 'exited', true]);
      expect(rowLinedFindings(row)?.shape, row.name).not.toBe('unparsed');
    }

    const left = unionFindings(body, B);
    const right = unionFindings(body, ['validate']);
    if (!left.ok || !right.ok) throw new Error(`union refused: ${left.ok ? '' : left.refusal} ${right.ok ? '' : right.refusal}`);
    // Not vacuous: B really reports the broken link (one code per verb that sees it), each with a line…
    const broken = left.keys.filter((key) => key.location === 'docs/guide.md');
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.map((key) => key.line)).toEqual(broken.map(() => 3));
    // …and validate reports every key of union(B), spelled identically.
    expect(right.keys).toEqual(expect.arrayContaining([...left.keys]));
  }, 30_000);
});
