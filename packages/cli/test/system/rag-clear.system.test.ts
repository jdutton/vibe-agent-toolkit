/**
 * System tests for rag clear command
 *
 * Tests the `vat rag clear` command which removes all indexed data from
 * the vector database and deletes the database directory.
 */

import { describe, executeCliAndParseYaml, expect, fs, getBinPath, getTestOutputDir, it, setupRagTestSuite } from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('clear', binPath, getTestOutputDir);

describe('RAG clear command (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should clear RAG database and delete directory', () => {
    // Verify database directory exists before clear
    expect(fs.existsSync(suite.dbPath)).toBe(true);

    // Verify database has data
    const { parsed: statsBefore } = executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(statsBefore.status).toBe('success');
    expect(statsBefore.totalChunks).toBeGreaterThan(0);

    // Clear database
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'clear', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.message).toBe('Database cleared');
    expect(parsed.duration).toBeDefined();

    // Verify database directory is deleted
    expect(fs.existsSync(suite.dbPath)).toBe(false);
  });
});
