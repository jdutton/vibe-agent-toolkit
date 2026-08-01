
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
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

  it('should scan directory and output YAML', async () => {
    // Create test markdown files
    writeTestFile(safePath.join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    writeTestFile(safePath.join(tempDir, 'other.md'), '# Other');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
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

  it('should exit 0 even if no files found', async () => {
    const result = await executeCli(binPath, ['resources', 'scan', tempDir]);

    expect(result.status).toBe(0);
  });

  it('should use current directory if no path provided', async () => {
    writeTestFile(safePath.join(tempDir, 'test.md'), '# Test');

    const result = await executeCli(binPath, ['resources', 'scan'], { cwd: tempDir });

    expect(result.status).toBe(0);
  });

  it('should scan multiple files successfully', async () => {
    // Create test files
    writeTestFile(safePath.join(tempDir, 'doc1.md'), '# Same Content\nThis is identical.');
    writeTestFile(safePath.join(tempDir, 'doc2.md'), '# Same Content\nThis is identical.');
    writeTestFile(safePath.join(tempDir, 'unique.md'), '# Different Content');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
    ]);

    expect(result.status).toBe(0);
    expect(parsed.filesScanned).toBe(3);
  });

  // Previously skipped as "--verbose conflicts with the parent command's
  // --verbose". There is no parent `--verbose`: `resources` declares none, and
  // `scan` declares its own. The skip outlived whatever provoked it and took
  // the ONLY coverage of the `files:` list — and of its paths — with it.
  it('should include checksums in file output with --verbose flag', async () => {
    writeTestFile(safePath.join(tempDir, 'test.md'), '# Test');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
      '--verbose',
    ]);

    expect(result.status).toBe(0);
    expect(parsed.files).toBeDefined();
    const files = parsed.files as Array<{ path: string; links: number; anchors: number; checksum: string }>;
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toHaveProperty('checksum');
    expect(files[0]?.checksum).toMatch(/^[a-f0-9]{64}$/); // SHA-256 format
  });

  it('states one root and reports every --verbose path relative to it', async () => {
    // The payload is machine-readable output. An absolute path in it names the
    // operator's home directory and makes two machines' runs undiffable, so the
    // document states its base once and everything under it is relative — the
    // same contract `vat audit` follows.
    // Nested on purpose: a bare filename would also satisfy a `basename()`
    // near-miss, so the subdirectory is what proves the path was re-based.
    mkdirSyncReal(safePath.join(tempDir, 'nested'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'nested', 'test.md'), '# Test');

    const { parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
      '--verbose',
    ]);

    expect(parsed.root).toBeDefined();
    const files = parsed.files as Array<{ path: string }>;
    expect(files.map(f => f.path)).toEqual(['nested/test.md']);
  });
});
