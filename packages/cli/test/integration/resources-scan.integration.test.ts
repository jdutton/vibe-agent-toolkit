import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  getBinPath,
  createTestTempDir,
  cleanupTestTempDir,
  writeTestFile,
  executeCli,
  executeCliAndParseYaml,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);

describe('vat resources scan (integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-scan-test-');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should scan directory and output YAML', () => {
    // Create test markdown files
    writeTestFile(join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    writeTestFile(join(tempDir, 'other.md'), '# Other');

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('---');
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('success');
    expect(parsed.filesScanned).toBeGreaterThan(0);
  });

  it('should exit 0 even if no files found', () => {
    const result = executeCli(binPath, ['resources', 'scan', tempDir]);

    expect(result.status).toBe(0);
  });

  it('should use current directory if no path provided', () => {
    writeTestFile(join(tempDir, 'test.md'), '# Test');

    const result = executeCli(binPath, ['resources', 'scan'], { cwd: tempDir });

    expect(result.status).toBe(0);
  });
});
