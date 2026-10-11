import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESOURCES_VALIDATE_REPORT_SCHEMA } from '../../src/commands/resources/validate-schema.js';
import {
  getBinPath,
  createTestTempDir,
  cleanupTestTempDir,
  writeTestFile,
  executeCli,
  executeCliAndParseYaml,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);

describe('vat resources validate (integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-validate-test-');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should validate valid resources and exit 0', async () => {
    writeTestFile(safePath.join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    writeTestFile(safePath.join(tempDir, 'other.md'), '# Other');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'validate',
      tempDir,
    ]);

    expect(result.status).toBe(0);
    const report = RESOURCES_VALIDATE_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(2);
  });

  it('should detect broken links and exit 1', async () => {
    writeTestFile(safePath.join(tempDir, 'README.md'), '[broken](./missing.md)');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'validate',
      tempDir,
    ]);

    expect(result.status).toBe(1);
    const report = RESOURCES_VALIDATE_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('findings');
    expect(report.findings).toMatchObject([{ code: 'LINK_BROKEN_FILE', severity: 'error', location: 'README.md' }]);
  });

  it('should print one compiler-style line per finding under --format text', async () => {
    writeTestFile(safePath.join(tempDir, 'test.md'), '[broken](./missing.md)');

    const result = await executeCli(binPath, ['resources', 'validate', tempDir, '--format', 'text']);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/test\.md:\d+: error: .*missing\.md.*\[LINK_BROKEN_FILE\]/);
  });

  it('should detect broken anchors', async () => {
    writeTestFile(safePath.join(tempDir, 'test.md'), '# Test\n[link](#missing)');

    const result = await executeCli(binPath, ['resources', 'validate', tempDir, '--format', 'text']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('#missing');
  });
});
