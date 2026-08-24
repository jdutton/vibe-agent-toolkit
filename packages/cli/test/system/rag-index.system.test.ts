/**
 * System tests for rag index command
 *
 * ⚠️ The `status: 'success'` assertions below were VACUOUS until the command
 * started deriving that field: it was a hardcoded literal beside an
 * unconditional `process.exit(0)`, so every case here passed no matter what
 * `indexResources` reported. They are real assertions now.
 *
 * The other half of that contract — a run with failing resources reporting
 * `status: 'partial'` and exiting 1 — is NOT covered here, and deliberately so.
 * A per-resource index error has to survive the crawl to reach
 * `indexResources`, and the crawl reads and parses every file itself
 * (`ResourceRegistry.addResource`), so an unreadable or malformed fixture is
 * dropped before indexing ever sees it — it produces a resource that is
 * *missing*, not one that *failed*. The failures actually observed in the wild
 * came from the chunker rejecting an over-long line, which is a moving target.
 * The status/exit mapping is therefore pinned as pure logic in
 * `test/commands/rag/index-outcome.test.ts` instead of manufactured here.
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
  safePath,
} from './test-common.js';
import { setupRagTestProject, setupTestProject } from './test-helpers/index.js';

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

  it('should index markdown files into RAG database', async () => {
    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', projectDir, '--db', dbPath],
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    // The exit code and the status have to agree, and `success` has to mean the
    // whole corpus landed: an `errors` list alongside exit 0 is the defect.
    expect(parsed.errors).toBeUndefined();
    expect(parsed.resourcesIndexed).toBeGreaterThan(0);
    expect(parsed.chunksCreated).toBeGreaterThan(0);
    expect(parsed.duration).toBeDefined();

    // Verify database was created
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('should index successfully on re-run', async () => {
    // Create a new project for this test with isolated database
    const reindexProjectDir = setupTestProject(tempDir, {
      name: 'reindex-test-project',
      withDocs: true,
    });
    const reindexDbPath = getTestOutputDir('cli', 'system', 'rag-index-reindex-db');

    const docsDir = safePath.join(reindexProjectDir, 'docs');
    fs.writeFileSync(
      safePath.join(docsDir, 'README.md'),
      '# Test\n\nContent for re-index test.\n\n## Section\n\nMore content here.'
    );

    // First index
    const { result: result1, parsed: parsed1 } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', reindexProjectDir, '--db', reindexDbPath],
      { cwd: reindexProjectDir }
    );

    expect(result1.status).toBe(0);
    expect(parsed1.status).toBe('success');
    expect(parsed1.resourcesIndexed).toBeGreaterThan(0);

    // Second index - nothing changed on disk, so the provider must recognise every
    // resource by its content hash and skip it rather than re-embedding it.
    const { result: result2, parsed: parsed2 } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', reindexProjectDir, '--db', reindexDbPath],
      { cwd: reindexProjectDir }
    );

    expect(result2.status).toBe(0);
    expect(parsed2.status).toBe('success');
    expect(parsed2.resourcesSkipped).toBe(parsed1.resourcesIndexed);
    expect(parsed2.resourcesIndexed).toBe(0);
    expect(parsed2.resourcesUpdated).toBe(0);
    expect(parsed2.chunksCreated).toBe(0);
  });

  it('should error when no path and no project root', async () => {
    // Create a temp dir without .git (no project root)
    const nonProjectDir = safePath.join(tempDir, 'non-project');
    fs.mkdirSync(nonProjectDir);

    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index'],
      { cwd: nonProjectDir }
    );

    expect(result.status).toBe(2); // System error
    expect(parsed.status).toBe('error');
    expect(result.stderr).toContain('No database path');
  });
});
