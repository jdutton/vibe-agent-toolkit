/**
 * System tests for rag stats command
 *
 * Tests the `vat rag stats` command which displays database statistics
 * including total chunks, resources, and embedding model information.
 */

import { RAG_STATS_REPORT_SCHEMA } from '../../src/commands/rag/admin-schema.js';

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

  it('should show RAG database statistics', async () => {
    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    const report = RAG_STATS_REPORT_SCHEMA.parse(parsed);
    expect(result.status).toBe(0);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(report.data?.totalChunks).toBeGreaterThan(0);
    expect(report.data?.totalResources).toBeGreaterThan(0);
    expect(report.data?.embeddingModel).not.toBe('');
    expect(Number.isNaN(Date.parse(report.data?.lastIndexed ?? ''))).toBe(false);
  });

  it('should return empty stats when database has no data', () => {
    const { result, parsed } = executeRagCommandInEmptyProject(
      suite.tempDir,
      binPath,
      ['rag', 'stats']
    );

    expect(result.status).toBe(0); // Success (empty is valid)
    expect(RAG_STATS_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'ok', data: { totalChunks: 0, totalResources: 0 } });
  });
});
