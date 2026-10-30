/**
 * The candidate build's CI verbs, run through the verdict facet against a
 * neutral committed subject, never exit 2. Exit 2 is VAT's usage/system-error
 * code: a row that exits 2 measured an argv the build rejects, not the subject,
 * so no committed expected-exit set may contain it and a verdict built on one
 * is void.
 *
 * Integration-tier: real git, the built vat at `packages/cli/dist/bin/vat.js`.
 * The capture runs each verb from a cleared environment with its own store,
 * tmp and home under `--out`, so the developer's HOME, TMPDIR and
 * CLAUDE_CONFIG_DIR never reach it.
 */

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { captureVerdict } from '../../src/facets/verdict/capture.js';
import { VERDICT_VERB_NAMES, type VerdictVerbName } from '../../src/facets/verdict/verbs.js';
import type { ResolvedInstrument } from '../../src/harness/types.js';
import { PROBE_VERSION } from '../command-probe.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';
import { cleanupVerdictFixtures, FIXTURE_ALIAS, tempDir } from '../integration/verdict-fixtures.js';

const VAT_BIN = resolveFromImportMeta(import.meta.url, '../../../cli/dist/bin/vat.js');
const VAT: ResolvedInstrument = { command: process.execPath, leadingArgs: [VAT_BIN], version: PROBE_VERSION };

/** The verbs a CI arm runs (`MEASURABLE_SEQUENCES`' steps, as verdict rows). */
const CI_VERBS: readonly VerdictVerbName[] = ['validate', 'resources-validate-ci', 'resources-check-ci', 'skills-validate-ci'];

afterAll(cleanupVerdictFixtures);

/** A committed subject: a config, one doc, one link — nothing proprietary. */
function subject(): string {
  const root = tempDir('lab-verdict-candidate-subject-');
  initRepo(root);
  writeFixtureFile(root, 'vibe-agent-toolkit.config.yaml', 'version: 1\n');
  writeFixtureFile(root, 'README.md', '# subject\n\nSee [the guide](docs/guide.md).\n');
  writeFixtureFile(root, 'docs/guide.md', '# guide\n');
  commitAll(root, 'subject');
  return root;
}

describe('the candidate verdict run', () => {
  it('names only verbs the facet knows', () => {
    expect(VERDICT_VERB_NAMES).toEqual(expect.arrayContaining([...CI_VERBS]));
  });

  it('never exits 2 on any CI verb', async () => {
    const root = subject();

    const result = await captureVerdict({
      instrument: VAT,
      subjects: [{ alias: FIXTURE_ALIAS, path: root, verbs: CI_VERBS, sqlFiles: [], buildVerbs: false, unmeasurableBuildVerbs: {} }],
      subjectsDir: root,
      env: { set: {}, unset: [] },
      outDir: tempDir('lab-verdict-candidate-out-'),
      capturedAt: new Date().toISOString(),
    });

    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
    const rows = result.envelopes[0]?.body.rows ?? [];
    expect(rows.map((row) => row.name)).toEqual([...CI_VERBS]);
    for (const row of rows) {
      expect({ name: row.name, outcome: row.outcome }).toEqual({ name: row.name, outcome: 'exited' });
      expect({ name: row.name, exitCode: row.exitCode }).not.toEqual({ name: row.name, exitCode: 2 });
    }
  }, 30_000);
});
