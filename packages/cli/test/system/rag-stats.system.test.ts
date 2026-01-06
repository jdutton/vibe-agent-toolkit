/**
 * System tests for rag stats command
 *
 * Tests the `vat rag stats` command which displays database statistics
 * including total chunks, resources, and embedding model information.
 */

import { getTestOutputDir } from '@vibe-agent-toolkit/utils';

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

describe('RAG stats command (system test)', () => {
  let tempDir: string;
  let projectDir: string;
  let dbPath: string;

  beforeAll(() => {
    // Use isolated test output directory to avoid conflicts in parallel test execution
    dbPath = getTestOutputDir('cli', 'system', 'rag-stats-db');
    ({ tempDir, projectDir } = setupIndexedRagTest(
      'vat-rag-stats-test-',
      'test-project',
      binPath,
      dbPath
    ));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should show RAG database statistics', () => {
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', dbPath],
      { cwd: projectDir }
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
      tempDir,
      binPath,
      ['rag', 'stats']
    );

    expect(result.status).toBe(0); // Success (empty is valid)
    expect(parsed.status).toBe('success');
    expect(parsed.totalChunks).toBe(0);
    expect(parsed.totalResources).toBe(0);
  });
});
