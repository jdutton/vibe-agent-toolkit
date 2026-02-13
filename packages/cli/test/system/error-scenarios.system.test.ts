import { it, beforeAll, afterAll } from 'vitest';

import { describe, expect, fs, getBinPath, join, spawnSync } from './test-common.js';
import {
  createTestTempDir,
  executeAndParseYaml,
  executeCli,
  setupTestProject,
  testConfigError,
} from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

describe('Error scenarios (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-error-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle invalid config file with exit code 2', () => {
    const result = testConfigError(
      tempDir,
      'invalid-config',
      'version: 999\n', // Invalid version
      binPath
    );

    expect(result.status).toBe(2); // System error
    expect(result.stderr).toContain('config');
  });

  it('should handle malformed YAML config', () => {
    const result = testConfigError(
      tempDir,
      'malformed-yaml',
      'version: 1\nresources:\n  - invalid: yaml: syntax:\n',
      binPath
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('config');
  });

  it('should handle non-existent directory path', () => {
    const nonExistentPath = join(tempDir, 'does-not-exist');

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'scan', nonExistentPath]
    );

    expect(result.status).toBe(2);
    expect(parsed.status).toBe('error');
  });

  it('should handle empty directory gracefully', () => {
    const emptyDir = join(tempDir, 'empty');
    fs.mkdirSync(emptyDir);

    const { result, parsed } = executeAndParseYaml(binPath, ['resources', 'scan', emptyDir]);

    expect(result.status).toBe(0); // Empty is not an error
    expect(parsed.status).toBe('success');
    expect(parsed.filesScanned).toBe(0);
  });

  it('should handle markdown parse errors gracefully', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'parse-error',
      withDocs: true,
    });

    // Create technically valid but edge-case markdown
    fs.writeFileSync(
      join(projectDir, 'docs/weird.md'),
      '# Test\n\n[]()' // Empty link - valid markdown, but edge case
    );

    const result = spawnSync('node', [binPath, 'resources', 'scan', projectDir], {
      encoding: 'utf-8',
    });

    // Should not crash, might warn
    expect(result.status).toBe(0);
  });

  it('should exit with 1 when validation finds errors', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'validation-errors',
      withDocs: true,
    });

    fs.writeFileSync(
      join(projectDir, 'docs/test.md'),
      '# Test\n\n[Broken link](./missing.md)'
    );

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'validate', projectDir]
    );

    expect(result.status).toBe(1); // Validation error, not system error
    expect(parsed.status).toBe('failed');
    expect(parsed.errorsFound).toBeGreaterThan(0);
  });

  it('should handle debug flag correctly', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'debug-test',
      config: 'version: 1\n',
      withDocs: true,
    });

    fs.writeFileSync(join(projectDir, 'docs/test.md'), '# Test');

    const result = spawnSync('node', [binPath, 'resources', 'scan', projectDir, '--debug'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    // Debug flag should at minimum not cause errors
    // If config is found, debug output will appear
    if (result.stderr.includes('[DEBUG]')) {
      expect(result.stderr).toContain('Scanning path');
    }
  });

  it('should handle multiple validation errors', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'multiple-errors',
      withDocs: true,
    });

    // Create file with multiple broken links
    fs.writeFileSync(
      join(projectDir, 'docs/broken.md'),
      '# Test\n\n[Link 1](./missing1.md)\n[Link 2](./missing2.md)\n[Link 3](#bad-anchor)'
    );

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'validate', projectDir]
    );

    expect(result.status).toBe(1);
    expect(parsed.errorsFound).toBeGreaterThanOrEqual(3);

    // Check errors are in structured output (not stderr by default)
    // Use text format to get stderr output
    const textResult = executeCli(binPath, ['resources', 'validate', projectDir, '--format', 'text']);
    expect(textResult.stderr).toContain('missing1.md');
    expect(textResult.stderr).toContain('missing2.md');
    expect(textResult.stderr).toContain('bad-anchor');
  });

  it('should handle circular links without crashing', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'circular',
      withDocs: true,
    });

    // Create circular references
    fs.writeFileSync(
      join(projectDir, 'docs/a.md'),
      '# A\n\n[Go to B](./b.md)'
    );
    fs.writeFileSync(
      join(projectDir, 'docs/b.md'),
      '# B\n\n[Go to A](./a.md)'
    );

    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'validate', projectDir]
    );

    // Should handle circular refs without infinite loop
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });
});
