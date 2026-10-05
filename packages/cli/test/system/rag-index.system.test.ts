/**
 * System tests for rag index command
 *
 * ⚠️ The clean-status assertions below were VACUOUS until the command started
 * deriving its status: it was a hardcoded literal beside an unconditional
 * `process.exit(0)`, so every case here passed no matter what
 * `indexResources` reported. Every document is now parsed with the verb's
 * published schema, and the status is the report's.
 *
 * The other half of that contract — a run that did not index everything it was
 * asked to reporting `status: findings` and exiting 1 — is covered by the
 * unreadable-file case below. A file the crawl enumerates and cannot READ never
 * reaches `indexResources` (the crawl reads and parses every file itself), so it
 * was a resource that is *missing* rather than one that *failed*: in none of
 * the provider's counters, not in its `errors`, and the report called a corpus
 * with a document absent from it clean. The registry keeps that log
 * (`getUnreadableResources()`); the command makes each one a
 * `RAG_DOCUMENT_INDEX_FAILED` finding. The provider's own per-resource failures
 * (the chunker rejecting an over-long line, an embedding error) are a moving
 * target and stay pinned as pure logic in `test/commands/rag/index-outcome.test.ts`.
 *
 * `chmod 000` is the fixture, so that case is POSIX-only and refuses to run as
 * root, where `chmod 000` denies nothing.
 */

import { getTestOutputDir , CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, it } from 'vitest';
import yaml from 'yaml';

import { RAG_INDEX_REPORT_SCHEMA } from '../../src/commands/rag/index-schema.js';

import {
  createTestTempDir,
  describe,
  executeCliAndParseYaml,
  expect,
  fs,
  getBinPath,
  safePath,
} from './test-common.js';
import { FINDER_DS_STORE, setupRagTestProject, setupTestProject } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

/** `chmod 000` denies nothing to uid 0 and does not exist on Windows — see the file header. */

/** `vat rag index [--db <db>]` from `cwd`: the exit code, the published refusal code and its message. */
async function indexRefusal(cwd: string, db?: string): Promise<{ exit: number | null; code: unknown; message: unknown }> {
  const { result } = await executeCliAndParseYaml(binPath, ['rag', 'index', ...(db === undefined ? [] : ['--db', db])], { cwd });
  const report = RAG_INDEX_REPORT_SCHEMA.parse(yaml.parse(result.stdout));
  return report.status === 'error'
    ? { exit: result.status, code: report.error.code, message: report.error.message }
    : { exit: result.status, code: report.status, message: undefined };
}

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

    const report = RAG_INDEX_REPORT_SCHEMA.parse(parsed);
    expect(result.status).toBe(0);
    // The exit code and the status have to agree, and `ok` has to mean the
    // whole corpus landed: a finding alongside exit 0 is the defect.
    expect(report.status).toBe('ok');
    expect(report.findings).toStrictEqual([]);
    expect(report.examined).toBeGreaterThanOrEqual(report.data?.resourcesIndexed ?? Number.NaN);
    expect(report.data?.resourcesIndexed).toBeGreaterThan(0);
    expect(report.data?.chunksCreated).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

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
    expect(parsed1.status).toBe('ok');
    const first = RAG_INDEX_REPORT_SCHEMA.parse(parsed1).data;
    expect(first?.resourcesIndexed).toBeGreaterThan(0);

    // Second index - nothing changed on disk, so the provider must recognise every
    // resource by its content hash and skip it rather than re-embedding it.
    const { result: result2, parsed: parsed2 } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index', reindexProjectDir, '--db', reindexDbPath],
      { cwd: reindexProjectDir }
    );

    expect(result2.status).toBe(0);
    expect(parsed2.status).toBe('ok');
    expect(RAG_INDEX_REPORT_SCHEMA.parse(parsed2).data).toMatchObject({
      resourcesSkipped: first?.resourcesIndexed,
      resourcesIndexed: 0,
      resourcesUpdated: 0,
      chunksCreated: 0,
    });
  });

  it.skipIf(CANNOT_DENY_READS)(
    'reports a RAG_DOCUMENT_INDEX_FAILED finding and exits 1 when a declared resource cannot be read, naming it',
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
      const report = RAG_INDEX_REPORT_SCHEMA.parse(parsed);
      expect(result.status).toBe(1);
      expect(report.status).toBe('findings');
      expect(report.data?.resourcesIndexed).toBe(1);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ code: 'RAG_DOCUMENT_INDEX_FAILED', severity: 'error', location: 'docs/locked.md' });
      expect(report.findings[0]?.message).toContain('EACCES');
    }
  );

  it('should error when no path and no project root', async () => {
    // Create a temp dir without .git (no project root)
    const nonProjectDir = safePath.join(tempDir, 'non-project');
    fs.mkdirSync(nonProjectDir);

    const { result } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'index'],
      { cwd: nonProjectDir }
    );

    expect(result.status).toBe(2); // System error
    expect(RAG_INDEX_REPORT_SCHEMA.parse(yaml.parse(result.stdout))).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
    expect(result.stderr).toContain('No database path');
  });

  // Where the database cannot go is the input (a file) or the run not finishing (unwritable) —
  // LanceDB's own failure for either used to publish INTERNAL_ERROR.
  it('a project .rag-db that is a file is INPUT_UNREADABLE; a --db that is one is USAGE_INVALID', async () => {
    const project = setupTestProject(tempDir, { name: 'index-rag-db-file', withDocs: true });
    fs.writeFileSync(safePath.join(project, '.rag-db'), 'not a database');

    expect(await indexRefusal(project)).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });
    expect(await indexRefusal(project, safePath.join(project, '.rag-db'))).toMatchObject({ exit: 2, code: 'USAGE_INVALID' });
  });

  // stats, query and clear refuse a directory that is not a RAG database; index wrote LanceDB
  // tables into it — `vat rag index --db .` filled the project root with `*.lance` directories.
  it('a --db directory holding foreign entries is USAGE_INVALID naming them, and nothing is written', async () => {
    const notDb = safePath.join(tempDir, 'index-into-foreign');
    fs.mkdirSync(notDb);
    fs.writeFileSync(safePath.join(notDb, 'keep.txt'), 'precious');

    const outcome = await indexRefusal(projectDir, notDb);

    expect(outcome).toMatchObject({ exit: 2, code: 'USAGE_INVALID' });
    // The directory by its basename: the refusal echoes --db as typed (`--db ../look` prints
    // `../look`), and this test types an absolute temp path, which is not the part worth pinning.
    expect(String(outcome.message)).toContain('index-into-foreign');
    expect(String(outcome.message)).toContain('keep.txt');
    expect(fs.readdirSync(notDb)).toEqual(['keep.txt']);
  });

  // No --db was given, so the project's own `.rag-db` holding other things is its state, not the invocation.
  it('a project .rag-db holding foreign entries is INPUT_UNREADABLE, and nothing is written', async () => {
    const project = setupTestProject(tempDir, { name: 'index-rag-db-foreign', withDocs: true });
    const projectDb = safePath.join(project, '.rag-db');
    fs.mkdirSync(projectDb);
    fs.writeFileSync(safePath.join(projectDb, 'notes.md'), 'mine');

    expect(await indexRefusal(project)).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });
    expect(fs.readdirSync(projectDb)).toEqual(['notes.md']);
  });

  // Operating-system litter says nothing about whose directory it is, as stats and clear already hold.
  it('a --db directory holding only OS litter is indexed into', async () => {
    const littered = safePath.join(tempDir, 'index-into-littered');
    fs.mkdirSync(littered);
    fs.writeFileSync(safePath.join(littered, '.DS_Store'), FINDER_DS_STORE);

    expect(await indexRefusal(projectDir, littered)).toMatchObject({ exit: 0, code: 'ok' });
  });

  it.skipIf(CANNOT_DENY_READS)('a --db whose parent is read-only is RUN_INCOMPLETE', async () => {
    const readOnly = safePath.join(tempDir, 'read-only-parent');
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o555);
    try {
      expect(await indexRefusal(projectDir, safePath.join(readOnly, 'db'))).toMatchObject({ exit: 2, code: 'RUN_INCOMPLETE' });
    } finally {
      fs.chmodSync(readOnly, 0o755);
    }
  });
});
