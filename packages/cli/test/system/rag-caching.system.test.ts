/**
 * System tests for RAG caching/incremental updates
 *
 * Tests that RAG correctly detects unchanged files and skips re-indexing.
 */

import { getTestOutputDir } from '@vibe-agent-toolkit/utils';

import {
  afterAll,
  beforeAll,
  describe,
  executeCliAndParseYaml,
  expect,
  fs,
  getBinPath,
  it,
  setupIndexedRagTest,
} from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);

describe('RAG caching and incremental updates (system test)', () => {
  let tempDir: string;
  let projectDir: string;
  let dbPath: string;

  beforeAll(() => {
    // Use isolated test output directory to avoid conflicts in parallel test execution
    dbPath = getTestOutputDir('cli', 'system', 'rag-caching-db');
    ({ tempDir, projectDir } = setupIndexedRagTest(
      'vat-rag-caching-test-',
      'test-project',
      binPath,
      dbPath
    ));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should skip unchanged files on re-index', () => {
    // setupIndexedRagTest already indexed files once
    // First re-index should skip all files (no changes)
    const { result: firstResult, parsed: firstParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(firstResult.status).toBe(0);
    expect(firstParsed.status).toBe('success');

    // All files should be skipped (content hash matches)
    const skippedCount = firstParsed.resourcesSkipped as number;
    expect(skippedCount).toBeGreaterThan(0);
    expect(firstParsed.resourcesIndexed).toBe(0);
    expect(firstParsed.chunksCreated).toBe(0);
    expect(firstParsed.chunksDeleted).toBe(0);

    // Second re-index should also skip all files
    const { result: secondResult, parsed: secondParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(secondResult.status).toBe(0);
    expect(secondParsed.status).toBe('success');

    // CRITICAL: All files should still be skipped (content hash matches)
    expect(secondParsed.resourcesSkipped).toBe(skippedCount);
    expect(secondParsed.resourcesIndexed).toBe(0);
    expect(secondParsed.chunksCreated).toBe(0);
    expect(secondParsed.chunksDeleted).toBe(0);
  });

  it('should detect and re-index changed files', () => {
    const testFile = `${projectDir}/docs/test-change.md`;

    // Create a test file
    fs.writeFileSync(testFile, '# Original Content\n\nThis is the original content.');

    // Index it
    const { parsed: firstParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(firstParsed.resourcesIndexed).toBeGreaterThanOrEqual(1);

    // Re-index without changes - should skip
    const { parsed: secondParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(secondParsed.resourcesSkipped).toBeGreaterThan(0);
    expect(secondParsed.resourcesIndexed).toBe(0);

    // Modify the file
    fs.writeFileSync(testFile, '# Modified Content\n\nThis content has been changed.');

    // Re-index - should detect change and update
    const { parsed: thirdParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(thirdParsed.resourcesUpdated).toBe(1);
    expect(thirdParsed.chunksDeleted).toBeGreaterThan(0);
    expect(thirdParsed.chunksCreated).toBeGreaterThan(0);

    // Clean up
    fs.unlinkSync(testFile);
  });
});
