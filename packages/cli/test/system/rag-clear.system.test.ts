/**
 * System tests for rag clear command
 *
 * Tests the `vat rag clear` command which removes all indexed data from
 * the vector database while preserving database structure.
 */

import { afterAll, beforeAll, it } from 'vitest';

import { executeCliAndParseYaml, getBinPath, setupIndexedRagTest } from './rag-test-setup.js';
import { describe, expect, fs } from './test-common.js';

const binPath = getBinPath(import.meta.url);

describe('RAG clear command (system test)', () => {
  let tempDir: string;
  let projectDir: string;

  beforeAll(() => {
    ({ tempDir, projectDir } = setupIndexedRagTest(
      'vat-rag-clear-test-',
      'test-project',
      binPath
    ));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should clear RAG database', () => {
    // Verify database has data
    const { parsed: statsBefore } = executeCliAndParseYaml(
      binPath,
      ['rag', 'stats'],
      { cwd: projectDir }
    );

    expect(statsBefore.status).toBe('success');
    expect(statsBefore.totalChunks).toBeGreaterThan(0);

    // Clear database
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'clear'],
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.message).toBe('Database cleared');
    expect(parsed.duration).toBeDefined();

    // Verify database is empty
    const { parsed: statsAfter } = executeCliAndParseYaml(
      binPath,
      ['rag', 'stats'],
      { cwd: projectDir }
    );

    expect(statsAfter.status).toBe('success');
    expect(statsAfter.totalChunks).toBe(0);
  });
});
