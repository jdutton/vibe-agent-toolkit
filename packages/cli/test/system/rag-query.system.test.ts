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

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.totalMatches).toBeGreaterThan(0);
    expect(parsed.searchDurationMs).toBeGreaterThan(0);
    expect(parsed.embeddingModel).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect((parsed.results as unknown[]).length).toBeGreaterThan(0);

    // Verify each result has expected fields
    const firstResult = (parsed.results as Array<Record<string, unknown>>)[0];
    expect(firstResult?.resourceId).toBeDefined();
    expect(firstResult?.filePath).toBeDefined();
    expect(firstResult?.content).toBeDefined();

    // Verify content is truncated (max 200 chars)
    const content = firstResult?.content as string;
    expect(content.length).toBeLessThanOrEqual(200 + 3); // +3 for "..." suffix
  });

  it('should limit results with --limit flag', () => {
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'query', 'documentation', '--limit', '2'],
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect((parsed.results as unknown[]).length).toBeLessThanOrEqual(2);
  });

  it('should error when database does not exist', () => {
    const { result, parsed } = executeRagCommandInEmptyProject(
      tempDir,
      binPath,
      ['rag', 'query', 'test']
    );

    expect(result.status).toBe(2); // System error
    expect(parsed.status).toBe('error');
    expect(result.stderr).toContain('not found in readonly mode');
  });
});
