/**
 * `vat resources validate` output must say what severity each finding is.
 *
 * The framework already resolves a severity per issue, and only `error` drives
 * the exit code. But this command's output did not carry that distinction
 * anywhere a reader could see it:
 *
 * - `--format text` printed every issue as `file:line:col: message`, so an
 *   info-severity note and a build-breaking error were byte-identical in shape.
 * - the structured output named four fields after "error" while three of them
 *   counted issues of ALL severities, producing objects that contradict
 *   themselves: `status: success` next to `filesWithErrors: 1` next to
 *   `errorsFound: 0` next to a non-empty `errors` array of info items.
 *
 * The consequence is not cosmetic. A real adopter scan returned 57 findings of
 * which only ~4 were errors, and the report had to be hand-classified before
 * anyone could tell which ones blocked — then asked for three separate codes to
 * be "downgraded to warnings" when all three were already `info`.
 *
 * `vat audit` is the sibling lane that gets this right (`issues: {errors,
 * warnings, info}` in aggregate and per file). These tests pin `resources
 * validate` to the same contract.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);

/**
 * An HTML fragment (no doctype) yields exactly one info-severity
 * `MALFORMED_HTML`; a markdown file linking a missing target yields exactly one
 * error-severity `LINK_BROKEN_FILE`. Together they exercise both severities in
 * one scan without needing any config.
 */
function writeMixedSeverityFixture(tempDir: string): void {
  writeTestFile(safePath.join(tempDir, 'fragment.component.html'), '<div>body</div>\n');
  writeTestFile(safePath.join(tempDir, 'doc.md'), '# Doc\n\n[gone](./nope.md)\n');
}

/** Only the info-severity finding, so every error-scoped count must be zero. */
function writeInfoOnlyFixture(tempDir: string): void {
  writeTestFile(safePath.join(tempDir, 'fragment.component.html'), '<div>body</div>\n');
}

interface SeverityCounts {
  errors: number;
  warnings: number;
  info: number;
}

describe('vat resources validate severity legibility (integration)', () => {
  let tempDir: string;

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('labels each text-format finding with its severity so info is distinguishable from error', async () => {
    tempDir = createTestTempDir('vat-resources-severity-text-');
    writeMixedSeverityFixture(tempDir);

    const result = await executeCli(binPath, ['resources', 'validate', tempDir, '--format', 'text']);

    // Text findings go to stderr, one per line, in `file:line:col: severity: message` form.
    expect(result.stderr).toMatch(/fragment\.component\.html:\d+:\d+: info: Malformed HTML/);
    expect(result.stderr).toMatch(/doc\.md:\d+:\d+: error: File not found/);
  });

  it('counts filesWithErrors by error severity only, not by "any issue"', async () => {
    tempDir = createTestTempDir('vat-resources-severity-counts-');
    writeMixedSeverityFixture(tempDir);

    const { parsed } = await executeCliAndParseYaml(binPath, ['resources', 'validate', tempDir]);

    // Two files carry a finding, but only doc.md carries an *error*.
    expect(parsed['errorsFound']).toBe(1);
    expect(parsed['filesWithErrors']).toBe(1);
  });

  it('reports a per-severity breakdown alongside the error-only counts', async () => {
    tempDir = createTestTempDir('vat-resources-severity-breakdown-');
    writeMixedSeverityFixture(tempDir);

    const { parsed } = await executeCliAndParseYaml(binPath, ['resources', 'validate', tempDir]);

    expect(parsed['issueCounts']).toEqual<SeverityCounts>({ errors: 1, warnings: 0, info: 1 });

    // The by-code summary and the detail array carry ALL severities, so they are
    // named `issue*`. An info-only scan must still report WHICH codes fired.
    expect(parsed['issueSummary']).toEqual({ MALFORMED_HTML: 1, LINK_BROKEN_FILE: 1 });
    const files = parsed['issues'] as Array<{ file: string; issues: Array<{ severity: string }> }>;
    expect(files.flatMap((f) => f.issues)).toHaveLength(2);

    // No field named after "error" may leak into the all-severity vocabulary.
    expect(parsed['errorSummary']).toBeUndefined();
    expect(parsed['errors']).toBeUndefined();
  });

  it('does not claim a file has errors when every finding on it is info', async () => {
    tempDir = createTestTempDir('vat-resources-severity-infoonly-');
    writeInfoOnlyFixture(tempDir);

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources', 'validate', tempDir,
    ]);

    // The self-contradicting shape this test exists to prevent: a successful run
    // that simultaneously reports a file with errors.
    expect(result.status).toBe(0);
    expect(parsed['status']).toBe('success');
    expect(parsed['errorsFound']).toBe(0);
    expect(parsed['filesWithErrors']).toBe(0);
    expect(parsed['issueCounts']).toEqual<SeverityCounts>({ errors: 0, warnings: 0, info: 1 });
  });
});
