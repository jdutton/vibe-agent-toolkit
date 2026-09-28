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
 * The report envelope is the contract now: every finding carries its
 * `severity`, `summary` counts findings by severity, and the per-file and
 * per-collection rows carry their own `summary` — one meaning of the word
 * everywhere. These tests pin `resources validate` to it.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { RESOURCES_VALIDATE_REPORT_SCHEMA, type ResourcesValidateReport } from '../../src/commands/resources/validate-schema.js';
import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
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

/** Run the verb and parse its stdout with the published schema. */
async function validateReport(args: readonly string[]): Promise<{ status: number | null; report: ResourcesValidateReport }> {
  const result = await executeCli(binPath, ['resources', 'validate', ...args]);
  return { status: result.status, report: RESOURCES_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout)) as ResourcesValidateReport };
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

    // One compiler-style line per finding on stdout: `location:line: severity: message [code]`.
    const lines = result.stdout.split('\n');
    expect(lines.find((line) => line.startsWith('fragment.component.html'))).toMatch(/: info: .*\[MALFORMED_HTML\]$/);
    expect(lines.find((line) => line.startsWith('doc.md:'))).toMatch(/: error: File not found.*\[LINK_BROKEN_FILE\]$/);
  });

  it('counts a file\'s errors by error severity only, not by "any issue"', async () => {
    tempDir = createTestTempDir('vat-resources-severity-counts-');
    writeMixedSeverityFixture(tempDir);

    const { report } = await validateReport([tempDir, '--verbose']);

    // Two files carry a finding, but only doc.md carries an *error*.
    const errorFiles = (report.data.files ?? []).filter((row) => row.summary.errors > 0).map((row) => row.path);
    expect(errorFiles).toEqual(['doc.md']);
    expect(report.summary.errors).toBe(1);
  });

  it('reports a per-severity breakdown, and each finding carries its own severity', async () => {
    tempDir = createTestTempDir('vat-resources-severity-breakdown-');
    writeMixedSeverityFixture(tempDir);

    const { report } = await validateReport([tempDir]);

    expect(report.summary).toEqual({ errors: 1, warnings: 0, info: 1 });
    expect(report.findings.map((finding) => `${finding.code}:${finding.severity}`).sort((a, b) => a.localeCompare(b))).toEqual([
      'LINK_BROKEN_FILE:error',
      'MALFORMED_HTML:info',
    ]);
  });

  it('does not fail, or claim an error, when every finding is info', async () => {
    tempDir = createTestTempDir('vat-resources-severity-infoonly-');
    writeInfoOnlyFixture(tempDir);

    const { status, report } = await validateReport([tempDir, '--verbose']);

    // `findings` (something was found) at exit 0 (nothing at error severity).
    expect(status).toBe(0);
    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 0, warnings: 0, info: 1 });
    expect(report.data.files?.every((row) => row.summary.errors === 0)).toBe(true);
  });
});
