import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('should validate valid resources and exit 0', () => {
    writeTestFile(join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    writeTestFile(join(tempDir, 'other.md'), '# Other');

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'resources',
      'validate',
      tempDir,
    ]);

    expect(result.status).toBe(0);
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('success');
  });

  it('should detect broken links and exit 1', () => {
    writeTestFile(join(tempDir, 'README.md'), '[broken](./missing.md)');

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'resources',
      'validate',
      tempDir,
    ]);

    expect(result.status).toBe(1);
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('failed');
    expect(parsed.errorsFound).toBeGreaterThan(0);
  });

  it('should output test-format errors to stderr', () => {
    writeTestFile(join(tempDir, 'test.md'), '[broken](./missing.md)');

    const result = executeCli(binPath, ['resources', 'validate', tempDir, '--format', 'text']);

    expect(result.stderr).toMatch(/test\.md:\d+:\d+: /);
    expect(result.stderr).toContain('missing.md');
  });

  it('should detect broken anchors', () => {
    writeTestFile(join(tempDir, 'test.md'), '# Test\n[link](#missing)');

    const result = executeCli(binPath, ['resources', 'validate', tempDir, '--format', 'text']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('#missing');
  });
});
