/**
 * The candidate build, run through the verdict facet against a clean neutral
 * committed subject, exits 0 on every CI verb — the committed state.
 *
 * Stronger than "never exits 2": a verb whose argv the build rejects (2), or
 * one that finds something in a subject holding nothing to find (1), measured
 * different work than CI does, and a verdict built on it is void. (The earlier
 * "not 2" form passed on a subject whose config the build rejected outright.)
 *
 * System-tier: real git, the built vat. The capture runs each verb from a
 * cleared environment with its own store, tmp and home under `--out`, so the
 * developer's HOME, TMPDIR and CLAUDE_CONFIG_DIR never reach it.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { captureVerdict } from '../../src/facets/verdict/capture.js';
import { VERDICT_VERB_NAMES, type VerdictVerbName } from '../../src/facets/verdict/verbs.js';
import { cleanupVerdictFixtures, FIXTURE_ALIAS, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_VAT, cleanSubject } from './candidate-subject.js';

/** The verdict rows of the verbs a CI arm runs. */
const CI_VERBS: readonly VerdictVerbName[] = ['validate', 'resources-validate-ci', 'resources-check-ci', 'skills-validate-ci'];

afterAll(cleanupVerdictFixtures);

describe('the candidate verdict run on a clean subject', () => {
  it('names only verbs the facet knows', () => {
    expect(VERDICT_VERB_NAMES).toEqual(expect.arrayContaining([...CI_VERBS]));
  });

  it('exits 0 on every CI verb', async () => {
    const root = cleanSubject();

    const result = await captureVerdict({
      instrument: CANDIDATE_VAT,
      subjects: [{ alias: FIXTURE_ALIAS, path: root, verbs: CI_VERBS, sqlFiles: [], buildVerbs: false, unmeasurableBuildVerbs: {} }],
      subjectsDir: root,
      env: { set: {}, unset: [] },
      outDir: tempDir('lab-verdict-candidate-out-'),
      capturedAt: new Date().toISOString(),
    });

    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
    const rows = result.envelopes[0]?.body.rows ?? [];
    expect(rows.map((row) => [row.name, row.outcome, row.exitCode])).toEqual(CI_VERBS.map((name) => [name, 'exited', 0]));
  }, 30_000);
});
