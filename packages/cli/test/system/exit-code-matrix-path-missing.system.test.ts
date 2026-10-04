/**
 * The exit-code matrix, one OUTCOME across every document verb that takes a
 * path: a path that does not exist. It is the invocation's mistake — nothing
 * could be examined — so it ends on 2 in every verb. Beside it, the same
 * question for `--collection`: a name the project does not declare.
 *
 * The matrix's other files and what holds them together:
 * `exit-code-matrix.system.test.ts`.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  byName,
  documentOf,
  expectErrorDocument,
  MATRIX_BIN_PATH,
  matrixTempDir,
  project,
  REGISTERED_ENVELOPE_VERBS,
  useMatrixTempDir,
} from './test-helpers/exit-code-matrix.js';
import { PATH_REFUSALS, PATH_VERBS } from './test-helpers/exit-code-path-verbs.js';
import { executeCli } from './test-helpers/index.js';

/** A project declaring `guides`, holding one file, and `empty`, which no file matches. */
const COLLECTION_CONFIG = 'resources:\n  collections:\n    guides:\n      include:\n        - "docs/*.md"\n'
  + '    empty:\n      include:\n        - "nothing/*.md"\n';

/** The verbs taking `--collection`: one flag, one meaning — an undeclared name is the invocation's mistake. */
const COLLECTION_VERBS: ReadonlyArray<{ readonly verb: string; readonly args: readonly string[] }> = [
  { verb: 'resources validate', args: ['resources', 'validate', '--format', 'json'] },
  { verb: 'resources scan', args: ['resources', 'scan', '--format', 'json'] },
];

describe('exit codes are derived from the published document — a path or collection that is not there (system test)', () => {
  useMatrixTempDir();

  describe('ONE outcome, one code: a path argument that does not exist', () => {
    it('names a refusal for EXACTLY the envelope verbs among the path verbs', () => {
      const envelopePathVerbs = PATH_VERBS.map(({ verb }) => verb).filter((verb) => REGISTERED_ENVELOPE_VERBS.includes(verb));
      expect(Object.keys(PATH_REFUSALS).toSorted(byName)).toStrictEqual(envelopePathVerbs.toSorted(byName));
    });

    it.each(PATH_VERBS)('$verb over a path that does not exist ends on ERROR', ({ verb, args }) => {
      const result = executeCli(MATRIX_BIN_PATH, args(safePath.join(matrixTempDir(), 'never-created')), { cwd: matrixTempDir() });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
      expectErrorDocument(result.stdout, PATH_REFUSALS[verb]?.missing);
    });
  });

  it.each(COLLECTION_VERBS)('$verb refuses a --collection the project does not declare as USAGE_INVALID', ({ verb, args }) => {
    const cwd = project(`collection-${verb.replace(' ', '-')}`, COLLECTION_CONFIG, { 'docs/a.md': '# A\n' });
    const result = executeCli(MATRIX_BIN_PATH, [...args, '--collection', 'guidez'], { cwd });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.ERROR);
    expectErrorDocument(result.stdout, 'USAGE_INVALID');
    expect(result.stderr).toContain('declared: guides, empty');
  });

  // A DECLARED collection no file matched is not the invocation's mistake — it
  // is a run over nothing, which the writer refuses as a finding (exit 1).
  it.each(COLLECTION_VERBS)('$verb over a declared collection no file matched ends on 1 with RESOURCE_CHECK_BROKEN', ({ verb, args }) => {
    const cwd = project(`collection-empty-${verb.replace(' ', '-')}`, COLLECTION_CONFIG, { 'docs/a.md': '# A\n' });
    const result = executeCli(MATRIX_BIN_PATH, [...args, '--collection', 'empty'], { cwd });
    const document = documentOf(result.stdout);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(ExitCode.FINDINGS);
    expect(document.status).toBe('findings');
    expect((document['findings'] as { code: string }[]).map((finding) => finding.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
  });
});
