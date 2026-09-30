/**
 * System tests for RAG caching/incremental updates
 *
 * Tests that RAG correctly detects unchanged files and skips re-indexing.
 */

import { RAG_INDEX_REPORT_SCHEMA, type RagIndexData } from '../../src/commands/rag/index-schema.js';

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

/** An index run's counters, from its document validated by the verb's published schema. */
function dataOf(parsed: Record<string, unknown>): RagIndexData {
  const { data } = RAG_INDEX_REPORT_SCHEMA.parse(parsed);
  if (data === null) throw new Error('rag index published no data');
  return data;
}
const suite = setupRagTestSuite('caching', binPath, getTestOutputDir);

describe('RAG caching and incremental updates (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should skip unchanged files on re-index', async () => {
    // setupIndexedRagTest already indexed files once
    // First re-index should skip all files (no changes)
    const { result: firstResult, parsed: firstParsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(firstResult.status).toBe(0);
    expect(firstParsed.status).toBe('ok');

    // All files should be skipped (content hash matches)
    const skippedCount = dataOf(firstParsed).resourcesSkipped;
    expect(skippedCount).toBeGreaterThan(0);
    expect(dataOf(firstParsed).resourcesIndexed).toBe(0);
    expect(dataOf(firstParsed).chunksCreated).toBe(0);
    expect(dataOf(firstParsed).chunksDeleted).toBe(0);

    // Second re-index should also skip all files
    const { result: secondResult, parsed: secondParsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(secondResult.status).toBe(0);
    expect(secondParsed.status).toBe('ok');

    // CRITICAL: All files should still be skipped (content hash matches)
    expect(dataOf(secondParsed).resourcesSkipped).toBe(skippedCount);
    expect(dataOf(secondParsed).resourcesIndexed).toBe(0);
    expect(dataOf(secondParsed).chunksCreated).toBe(0);
    expect(dataOf(secondParsed).chunksDeleted).toBe(0);
  });

  it('should detect and re-index changed files', async () => {
    const testFile = `${suite.projectDir}/docs/test-change.md`;

    // Create a test file
    fs.writeFileSync(testFile, '# Original Content\n\nThis is the original content.');

    // Index it
    const { parsed: firstParsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(dataOf(firstParsed).resourcesIndexed).toBeGreaterThanOrEqual(1);

    // Re-index without changes - should skip
    const { parsed: secondParsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(dataOf(secondParsed).resourcesSkipped).toBeGreaterThan(0);
    expect(dataOf(secondParsed).resourcesIndexed).toBe(0);

    // Modify the file
    fs.writeFileSync(testFile, '# Modified Content\n\nThis content has been changed.');

    // Re-index - should detect change and update
    const { parsed: thirdParsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(dataOf(thirdParsed).resourcesUpdated).toBe(1);
    expect(dataOf(thirdParsed).chunksDeleted).toBeGreaterThan(0);
    expect(dataOf(thirdParsed).chunksCreated).toBeGreaterThan(0);

    // Clean up
    fs.unlinkSync(testFile);
  });
});
