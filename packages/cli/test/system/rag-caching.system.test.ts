/**
 * System tests for RAG caching/incremental updates
 *
 * Tests that RAG correctly detects unchanged files and skips re-indexing.
 */

import {
  describe,
  executeCliAndParseYaml,
  expect,
  fs,
  getBinPath,
  getTestOutputDir,
  it,
  setupRagTestSuite,
} from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('caching', binPath, getTestOutputDir);

describe('RAG caching and incremental updates (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should skip unchanged files on re-index', () => {
    // setupIndexedRagTest already indexed files once
    // First re-index should skip all files (no changes)
    const { result: firstResult, parsed: firstParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
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
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
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
    const testFile = `${suite.projectDir}/docs/test-change.md`;

    // Create a test file
    fs.writeFileSync(testFile, '# Original Content\n\nThis is the original content.');

    // Index it
    const { parsed: firstParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(firstParsed.resourcesIndexed).toBeGreaterThanOrEqual(1);

    // Re-index without changes - should skip
    const { parsed: secondParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(secondParsed.resourcesSkipped).toBeGreaterThan(0);
    expect(secondParsed.resourcesIndexed).toBe(0);

    // Modify the file
    fs.writeFileSync(testFile, '# Modified Content\n\nThis content has been changed.');

    // Re-index - should detect change and update
    const { parsed: thirdParsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(thirdParsed.resourcesUpdated).toBe(1);
    expect(thirdParsed.chunksDeleted).toBeGreaterThan(0);
    expect(thirdParsed.chunksCreated).toBeGreaterThan(0);

    // Clean up
    fs.unlinkSync(testFile);
  });
});
