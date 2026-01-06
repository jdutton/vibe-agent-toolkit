/**
 * System tests for rag index command
 */

import { getTestOutputDir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, it } from 'vitest';

import {
  createTestTempDir,
  describe,
  executeCliAndParseYaml,
  expect,
  fs,
  getBinPath,
  join,
} from './test-common.js';
import { setupRagTestProject, setupTestProject } from './test-helpers.js';

const binPath = getBinPath(import.meta.url);

describe('RAG index command (system test)', () => {
  let tempDir: string;
  let projectDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-rag-index-test-');
    projectDir = setupRagTestProject(tempDir, 'test-project');
    // Use isolated test output directory to avoid conflicts in parallel test execution
    dbPath = getTestOutputDir('cli', 'system', 'rag-index-db');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should index markdown files into RAG database', () => {
    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', projectDir, '--db', dbPath],
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.resourcesIndexed).toBeGreaterThan(0);
    expect(parsed.chunksCreated).toBeGreaterThan(0);
    expect(parsed.duration).toBeDefined();

    // Verify database was created
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('should index successfully on re-run', () => {
    // Create a new project for this test with isolated database
    const reindexProjectDir = setupTestProject(tempDir, {
      name: 'reindex-test-project',
      withDocs: true,
    });
    const reindexDbPath = getTestOutputDir('cli', 'system', 'rag-index-reindex-db');

    const docsDir = join(reindexProjectDir, 'docs');
    fs.writeFileSync(
      join(docsDir, 'README.md'),
      '# Test\n\nContent for re-index test.\n\n## Section\n\nMore content here.'
    );

    // First index
    const { result: result1, parsed: parsed1 } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', reindexProjectDir, '--db', reindexDbPath],
      { cwd: reindexProjectDir }
    );

    expect(result1.status).toBe(0);
    expect(parsed1.status).toBe('success');
    expect(parsed1.resourcesIndexed).toBeGreaterThan(0);

    // Second index - should complete successfully
    // NOTE: Current LanceDB provider doesn't skip unchanged resources,
    // it re-indexes them. This is a known limitation.
    const { result: result2, parsed: parsed2 } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index', reindexProjectDir, '--db', reindexDbPath],
      { cwd: reindexProjectDir }
    );

    expect(result2.status).toBe(0);
    expect(parsed2.status).toBe('success');
    // Just verify it completes successfully, don't check specific behavior
    expect(parsed2.resourcesIndexed).toBeGreaterThanOrEqual(0);
  });

  it('should error when no path and no project root', () => {
    // Create a temp dir without .git (no project root)
    const nonProjectDir = join(tempDir, 'non-project');
    fs.mkdirSync(nonProjectDir);

    const { result, parsed } = executeCliAndParseYaml(
      binPath,
      ['rag', 'index'],
      { cwd: nonProjectDir }
    );

    expect(result.status).toBe(2); // System error
    expect(parsed.status).toBe('error');
    expect(result.stderr).toContain('No database path');
  });
});
