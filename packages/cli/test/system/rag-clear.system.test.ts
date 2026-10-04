/**
 * System tests for rag clear command
 *
 * Tests the `vat rag clear` command which removes all indexed data from
 * the vector database and deletes the database directory.
 */

import { RAG_CLEAR_REPORT_SCHEMA } from '../../src/commands/rag/admin-schema.js';

import { describe, executeCliAndParseYaml, expect, fs, getBinPath, getTestOutputDir, it, setupRagTestSuite } from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('clear', binPath, getTestOutputDir);

describe('RAG clear command (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should clear RAG database and delete directory', async () => {
    // Verify database directory exists before clear
    expect(fs.existsSync(suite.dbPath)).toBe(true);

    // Verify database has data
    const { parsed: statsBefore } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(statsBefore).toMatchObject({ status: 'ok', data: { totalChunks: expect.any(Number) } });
    expect((statsBefore['data'] as { totalChunks: number }).totalChunks).toBeGreaterThan(0);

    // Clear database
    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'clear', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(result.status).toBe(0);
    expect(RAG_CLEAR_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'ok', examined: 1, data: { cleared: true } });

    // Verify database directory is deleted
    expect(fs.existsSync(suite.dbPath)).toBe(false);
  });
});
