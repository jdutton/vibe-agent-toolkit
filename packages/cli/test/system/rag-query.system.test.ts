/**
 * System tests for rag query command
 *
 * Tests the `vat rag query` command which searches the vector database
 * for relevant content chunks based on semantic similarity.
 */

import {
  afterAll,
  beforeAll,
  describe,
  executeCliAndParseYaml,
  executeRagCommandInEmptyProject,
  expect,
  fs,
  getBinPath,
  it,
  setupIndexedRagTest,
} from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);

describe('RAG query command (system test)', () => {
  let tempDir: string;
  let projectDir: string;

  beforeAll(() => {
    ({ tempDir, projectDir } = setupIndexedRagTest(
      'vat-rag-query-test-',
      'test-project',
      binPath
    ));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should query RAG database and return results', () => {
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'query', 'documentation'],
      { cwd: projectDir }
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = parsed as any;

    expect(result.status).toBe(0);
    expect(output.status).toBe('success');
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
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'query', 'documentation', '--limit', '2'],
      { cwd: projectDir }
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = parsed as any;

    expect(result.status).toBe(0);
    expect(output.status).toBe('success');
    expect(Array.isArray(output.chunks)).toBe(true);
    expect(output.chunks.length).toBeLessThanOrEqual(2);
  });

  it('should error when database has no data', () => {
    const { result, parsed } = executeRagCommandInEmptyProject(
      tempDir,
      binPath,
      ['rag', 'query', 'test']
    );

    expect(result.status).toBe(2); // System error
    expect(parsed.status).toBe('error');
    expect(result.stderr).toContain('No data indexed yet');
  });
});
