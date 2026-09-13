/**
 * System tests for rag index command
 *
 * ⚠️ The `status: 'success'` assertions below were VACUOUS until the command
 * started deriving that field: it was a hardcoded literal beside an
 * unconditional `process.exit(0)`, so every case here passed no matter what
 * `indexResources` reported. They are real assertions now.
 *
 * The other half of that contract — a run that did not index everything it was
 * asked to reporting `status: 'partial'` and exiting 1 — is covered by the
 * unreadable-file case below. A file the crawl enumerates and cannot READ never
 * reaches `indexResources` (the crawl reads and parses every file itself), so it
 * was a resource that is *missing* rather than one that *failed*: in none of
 * the provider's counters, not in its `errors`, and the report said `success`
 * over a corpus with a document absent from it. The registry keeps that log
 * (`getUnreadableResources()`); the command now folds it into `errors`. The
 * provider's own per-resource failures (the chunker rejecting an over-long
 * line, an embedding error) are a moving target and stay pinned as pure logic
 * in `test/commands/rag/index-outcome.test.ts`.
 *
 * `chmod 000` is the fixture, so that case is POSIX-only and refuses to run as
 * root, where `chmod 000` denies nothing.
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

/** `chmod 000` denies nothing to uid 0 and does not exist on Windows — see the file header. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

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

  it.skipIf(CANNOT_DENY_READS)(
    'reports partial and exits 1 when a declared resource cannot be read, naming it',
    async () => {
      const unreadableProjectDir = setupTestProject(tempDir, {
        name: 'unreadable-test-project',
        withDocs: true,
      });
      const unreadableDbPath = getTestOutputDir('cli', 'system', 'rag-index-unreadable-db');
      const docsDir = safePath.join(unreadableProjectDir, 'docs');
      fs.writeFileSync(safePath.join(docsDir, 'good.md'), '# Good\n\nReadable prose.\n');
      const lockedPath = safePath.join(docsDir, 'locked.md');
      fs.writeFileSync(lockedPath, '# Locked\n\nProse nobody can read.\n');
      fs.chmodSync(lockedPath, 0o000);

      const { result, parsed } = await executeCliAndParseYaml(
        binPath,
        ['rag', 'index', unreadableProjectDir, '--db', unreadableDbPath],
        { cwd: unreadableProjectDir }
      );

      // The readable neighbour is indexed and the report is complete: this is a
      // REPORTED outcome (exit 1), not a command that could not run (exit 2).
      expect(result.status).toBe(1);
      expect(parsed.status).toBe('partial');
      expect(parsed.resourcesIndexed).toBe(1);
      const errors = parsed.errors as { resourceId: string; error: string }[];
      expect(errors).toHaveLength(1);
      expect(errors[0]?.resourceId).toBe('docs/locked.md');
      expect(errors[0]?.error).toContain('EACCES');
    }
  );

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
