/**
 * System tests for rag clear command
 *
 * Tests the `vat rag clear` command which removes all indexed data from
 * the vector database and deletes the database directory.
 */

import { getTestOutputDir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeCliAndParseYaml, fs, getBinPath, setupIndexedRagTest } from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);

describe('RAG clear command (system test)', () => {
  let tempDir: string;
  let projectDir: string;
  let dbPath: string;

  beforeAll(() => {
    // Use isolated test output directory to avoid conflicts in parallel test execution
    dbPath = getTestOutputDir('cli', 'system', 'rag-clear-db');
    ({ tempDir, projectDir } = setupIndexedRagTest(
      'vat-rag-clear-test-',
      'test-project',
      binPath,
      dbPath
    ));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should clear RAG database and delete directory', () => {
    // Verify database directory exists before clear
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify database has data
    const { parsed: statsBefore } = executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(statsBefore.status).toBe('success');
    expect(statsBefore.totalChunks).toBeGreaterThan(0);

    // Clear database
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'clear', '--db', dbPath],
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.message).toBe('Database cleared');
    expect(parsed.duration).toBeDefined();

    // Verify database directory is deleted
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
