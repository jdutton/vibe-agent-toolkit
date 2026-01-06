/**
 * System tests for rag query command
 *
 * Tests the `vat rag query` command which searches the vector database
 * for relevant content chunks based on semantic similarity.
 */

import {
  describe,
  executeRagCommandInEmptyProject,
  executeRagQueryAndExpectSuccess,
  expect,
  getBinPath,
  getTestOutputDir,
  it,
  setupRagTestSuite,
} from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('query', binPath, getTestOutputDir);

describe('RAG query command (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should query RAG database and return results', () => {
    const { output } = executeRagQueryAndExpectSuccess(
      binPath,
      ['rag', 'query', 'documentation', '--db', suite.dbPath],
      suite.projectDir
    );
    expect(output.stats).toBeDefined();
    expect(output.stats.totalMatches).toBeGreaterThan(0);
    expect(output.stats.searchDurationMs).toBeGreaterThan(0);
    expect(output.stats.embedding.model).toBeDefined();
    expect(Array.isArray(output.chunks)).toBe(true);
    expect(output.chunks.length).toBeGreaterThan(0);

    // Verify each chunk has expected fields
    const firstChunk = output.chunks[0];
    expect(firstChunk?.chunkId).toBeDefined();
    expect(firstChunk?.resourceId).toBeDefined();
    expect(firstChunk?.filePath).toBeDefined();
    expect(firstChunk?.content).toBeDefined();
    expect(firstChunk?.contentHash).toBeDefined();
    expect(firstChunk?.embeddingModel).toBeDefined();

    // Verify content is full (not truncated)
    const content = firstChunk?.content as string;
    expect(content.length).toBeGreaterThan(0);
  });

  it('should limit results with --limit flag', () => {
    const { output } = executeRagQueryAndExpectSuccess(
      binPath,
      ['rag', 'query', 'documentation', '--limit', '2', '--db', suite.dbPath],
      suite.projectDir
    );
    expect(Array.isArray(output.chunks)).toBe(true);
    expect(output.chunks.length).toBeLessThanOrEqual(2);
  });

  it('should error when database has no data', () => {
    const { result, parsed } = executeRagCommandInEmptyProject(
      suite.tempDir,
      binPath,
      ['rag', 'query', 'test']
    );

    expect(result.status).toBe(2); // System error
    expect(parsed.status).toBe('error');
    expect(result.stderr).toContain('No data indexed yet');
  });
});
