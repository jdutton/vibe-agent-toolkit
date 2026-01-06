/**
 * System tests for rag stats command
 *
 * Tests the `vat rag stats` command which displays database statistics
 * including total chunks, resources, and embedding model information.
 */

import {
  describe,
  executeCliAndParseYaml,
  executeRagCommandInEmptyProject,
  expect,
  getBinPath,
  getTestOutputDir,
  it,
  setupRagTestSuite,
} from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('stats', binPath, getTestOutputDir);

describe('RAG stats command (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should show RAG database statistics', () => {
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.totalChunks).toBeGreaterThan(0);
    expect(parsed.totalResources).toBeGreaterThan(0);
    expect(parsed.embeddingModel).toBeDefined();
    expect(typeof parsed.embeddingModel).toBe('string');
    expect(parsed.duration).toBeDefined();
  });

  it('should return empty stats when database has no data', () => {
    const { result, parsed } = executeRagCommandInEmptyProject(
      suite.tempDir,
      binPath,
      ['rag', 'stats']
    );

    expect(result.status).toBe(0); // Success (empty is valid)
    expect(parsed.status).toBe('success');
    expect(parsed.totalChunks).toBe(0);
    expect(parsed.totalResources).toBe(0);
  });
});
