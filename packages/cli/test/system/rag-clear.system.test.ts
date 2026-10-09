/**
 * System tests for rag clear command
 *
 * Tests the `vat rag clear` command which removes all indexed data from
 * the vector database and deletes the database directory.
 */

import { basename } from 'node:path';

import { createSymlink, mkdirSyncReal, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, type FaultFsSpec } from '@vibe-agent-toolkit/utils/testing';
import YAML from 'yaml';

import { RAG_CLEAR_REPORT_SCHEMA } from '../../src/commands/rag/admin-schema.js';

import { describe, executeCliAndParseYaml, expect, FINDER_DS_STORE, fs, getBinPath, getTestOutputDir, it, setupRagTestSuite } from './rag-test-setup.js';
import { executeCli, getMonorepoRoot } from './test-common.js';
import { setupTestProject } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);
/** The in-process fault injector, loaded into the spawned binary before it runs (`VAT_FAULT_FS` says what to fail). */
const faultPreload = safePath.join(getMonorepoRoot(import.meta.url), 'packages', 'utils', 'dist', 'testing', 'fault-fs-preload.js');
const suite = setupRagTestSuite('clear', binPath, getTestOutputDir);

/**
 * The child's temp root: the suite's own scratch tree. `clear` removes recursively, so no spawned run
 * here may reach the real `$TMPDIR` (DESTRUCTIVE-CODE rule).
 */
function scratchTmp(): Record<string, string> {
  return { TMPDIR: suite.tempDir, TEMP: suite.tempDir, TMP: suite.tempDir };
}

/** Run `vat rag <args>` from `cwd` and return the exit code, the published refusal code and its message. */
async function runRag(args: string[], cwd: string): Promise<{ exit: number | null; code: unknown; message: unknown }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, ['rag', ...args], { cwd, env: scratchTmp() });
  const error = parsed['error'] as { code?: unknown; message?: unknown } | undefined;
  return { exit: result.status, code: error?.code, message: error?.message };
}

/**
 * Overwrite files under `dir` with bytes LanceDB cannot read, keeping the tree's shape —
 * every file, or (`dataOnly`) only the `data/` fragments, which leaves each table's
 * manifest intact so the table OPENS and the failure comes on the first read.
 */
function corrupt(dir: string, dataOnly = false): void {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    // A database LanceDB wrote holds no links; one would be written through, outside `dir`.
    if (entry.isSymbolicLink()) throw new Error(`unexpected link in a RAG database: ${entry.name}`);
    if (!entry.isFile() || (dataOnly && basename(entry.parentPath) !== 'data')) continue;
    fs.writeFileSync(safePath.join(entry.parentPath, entry.name), 'garbage');
  }
}

/** A copy of the suite's indexed database at `<tempDir>/<name>`. */
function copyOfDatabase(name: string): string {
  const copy = safePath.join(suite.tempDir, name);
  fs.cpSync(suite.dbPath, copy, { recursive: true });
  return copy;
}

describe('RAG clear command (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  // `clear` deletes recursively, so a --db that is not VAT's database must be refused
  // BEFORE anything is removed — `vat rag clear --db ..` from docs/ used to delete the project.
  it.each([['stats'], ['clear']])('rag %s --db <a directory that is not a RAG database> is USAGE_INVALID and touches nothing', async (verb) => {
    const notDb = safePath.join(suite.tempDir, `not-a-db-${verb}`);
    mkdirSyncReal(safePath.join(notDb, 'sub'), { recursive: true });
    fs.writeFileSync(safePath.join(notDb, 'keep.txt'), 'precious');

    const outcome = await runRag([verb, '--db', notDb], suite.projectDir);

    expect(outcome).toMatchObject({ exit: 2, code: 'USAGE_INVALID' });
    expect(String(outcome.message)).toContain('keep.txt');
    expect(fs.readFileSync(safePath.join(notDb, 'keep.txt'), 'utf8')).toBe('precious');
    expect(fs.existsSync(safePath.join(notDb, 'sub'))).toBe(true);
  });

  // docs/architecture/rag.md tells a user with an unreadable database to `vat rag clear` it:
  // that only works if clear does not have to OPEN the database it is removing.
  it('a corrupt database: stats is INPUT_UNREADABLE, and clear removes it', async () => {
    const corrupted = copyOfDatabase('corrupt-db');
    corrupt(corrupted);

    expect(await runRag(['stats', '--db', corrupted], suite.projectDir)).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });

    const { result, parsed } = await executeCliAndParseYaml(binPath, ['rag', 'clear', '--db', corrupted], { cwd: suite.projectDir, env: scratchTmp() });
    expect(result.status).toBe(0);
    expect(RAG_CLEAR_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'ok', data: { cleared: true } });
    expect(fs.existsSync(corrupted)).toBe(false);
  });

  // Damaged data files behind an intact manifest: the table opens, and the READ fails.
  // That read failure was uncoded, so stats and query ended INTERNAL_ERROR.
  // `index` too: its change-detection read is that same first read, and it reported the store's
  // failure as one RAG_DOCUMENT_INDEX_FAILED finding per resource (exit 1).
  it.each([['stats'], ['query', 'widgets'], ['index']])('rag %s over damaged data files is INPUT_UNREADABLE, never INTERNAL_ERROR', async (...verb) => {
    const damaged = copyOfDatabase(`damaged-data-${verb[0]}`);
    corrupt(damaged, true);

    expect(await runRag([...verb, '--db', damaged], suite.projectDir)).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });
  });

  // Finder writes `.DS_Store` into any folder a person opens: still the database vat rag index wrote.
  it('a database holding .DS_Store is still a database', async () => {
    const littered = copyOfDatabase('littered-db');
    fs.writeFileSync(safePath.join(littered, '.DS_Store'), FINDER_DS_STORE);

    expect(await runRag(['stats', '--db', littered], suite.projectDir)).toMatchObject({ exit: 0 });
  });

  // Litter is a FILE the OS wrote: a `._notes/` DIRECTORY of the user's files once let clear rm -rf the tree.
  it('rag clear --db <a directory whose litter-named entry is a directory> is USAGE_INVALID and removes nothing', async () => {
    const lookalike = safePath.join(suite.tempDir, 'litter-lookalike');
    mkdirSyncReal(safePath.join(lookalike, '._notes'), { recursive: true });
    fs.writeFileSync(safePath.join(lookalike, '._notes', 'a.txt'), 'precious');
    fs.writeFileSync(safePath.join(lookalike, '.DS_Store'), FINDER_DS_STORE);

    const outcome = await runRag(['clear', '--db', lookalike], suite.projectDir);

    expect(outcome).toMatchObject({ exit: 2, code: 'USAGE_INVALID' });
    expect(String(outcome.message)).toContain('._notes');
    expect(fs.readFileSync(safePath.join(lookalike, '._notes', 'a.txt'), 'utf8')).toBe('precious');
  });

  // A litter NAME is not litter: a user's own `._notes` file once went with the database.
  it('rag clear --db <a database beside a user file named ._notes> is USAGE_INVALID and removes nothing', async () => {
    const beside = copyOfDatabase('apple-double-lookalike');
    fs.writeFileSync(safePath.join(beside, '._notes'), 'my notes');

    const outcome = await runRag(['clear', '--db', beside], suite.projectDir);

    expect(outcome).toMatchObject({ exit: 2, code: 'USAGE_INVALID' });
    expect(String(outcome.message)).toContain('._notes');
    expect(fs.readFileSync(safePath.join(beside, '._notes'), 'utf8')).toBe('my notes');
  });

  // Removing a link removes only the link: the index it names survived a `cleared: true` report.
  it('rag clear --db <a link to a database> is USAGE_INVALID naming the real path, and removes nothing', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const real = copyOfDatabase('linked-real-db');
    const link = safePath.join(suite.tempDir, 'linked-db');
    createSymlink(cap, real, link, 'dir');

    const outcome = await runRag(['clear', '--db', link], suite.projectDir);

    expect(outcome).toMatchObject({ exit: 2, code: 'USAGE_INVALID' });
    expect(String(outcome.message)).toContain('linked-real-db');
    expect(String(outcome.message)).toMatch(/Run vat rag clear --db \S*linked-real-db to clear the database itself\./);
    expect(String(outcome.message)).not.toContain('refusing to replace');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(real)).toContain('rag_chunks.lance');
  });

  // The project's own `.rag-db` holding other things: no --db was given, so the project's state is at fault.
  it('a project .rag-db holding foreign entries is INPUT_UNREADABLE, not USAGE_INVALID', async () => {
    const project = setupTestProject(suite.tempDir, { name: 'rag-db-foreign', withDocs: true });
    mkdirSyncReal(safePath.join(project, '.rag-db'), { recursive: true });
    fs.writeFileSync(safePath.join(project, '.rag-db', 'notes.md'), 'mine');

    expect(await runRag(['clear'], project)).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });
    expect(fs.existsSync(safePath.join(project, '.rag-db', 'notes.md'))).toBe(true);
  });

  // A read-only directory the user owns does not stop the removal: it is made writable on the way down.
  it.skipIf(CANNOT_DENY_READS)('a database holding a read-only directory is cleared whole', async () => {
    const readOnly = copyOfDatabase('read-only-db');
    fs.chmodSync(safePath.join(readOnly, 'rag_chunks.lance', 'data'), 0o555);

    expect(await runRag(['clear', '--db', readOnly], suite.projectDir)).toMatchObject({ exit: 0 });
    expect(fs.existsSync(readOnly)).toBe(false);
  });

  // A removal the OS stops (one data file it will not unlink, injected into the spawned binary) is
  // RUN_INCOMPLETE, never INTERNAL_ERROR — and since the database was moved off its path whole
  // first, nothing is left at --db: the clear is done, and a warning names where the rest is.
  it('a clear the OS stops partway is RUN_INCOMPLETE, leaves nothing at --db, and names where the rest is', async () => {
    const partial = copyOfDatabase('partial-db');
    const spec: FaultFsSpec = { within: suite.tempDir, faults: [{ family: 'remove', op: 'unlink', pathIncludes: '/rag_chunks.lance/data/', errno: 'EBUSY' }] };
    const result = await executeCli(binPath, ['rag', 'clear', '--db', partial], { cwd: suite.projectDir, nodeArgs: ['--import', faultPreload], env: { ...scratchTmp(), VAT_FAULT_FS: JSON.stringify(spec) } });
    const [first] = YAML.parseAllDocuments(result.stdout);
    const document = first?.toJS() as { error?: { code?: string; message?: string }; data?: unknown; findings?: Array<{ code?: string; link?: string }> } | undefined;
    const error = document?.error;

    expect({ exit: result.status, code: error?.code }, result.stderr).toEqual({ exit: 2, code: 'RUN_INCOMPLETE' });
    expect(fs.existsSync(partial)).toBe(false);
    const parked = fs.readdirSync(suite.tempDir).find((name) => name.startsWith('.partial-db.') && name.endsWith('.previous'));
    expect(parked).toBeDefined();
    expect(error?.message).toContain(parked);
    expect(document?.data).toEqual({ cleared: true });
    expect(document?.findings).toMatchObject([{ code: 'TREE_CLEANUP_INCOMPLETE', link: expect.stringContaining(parked ?? '-') }]);
  });

  // The project's default `.rag-db` is a FILE: that is not "nothing indexed yet".
  it('a project whose .rag-db is a file says so, not that nothing was indexed', async () => {
    const project = setupTestProject(suite.tempDir, { name: 'rag-db-is-a-file', withDocs: true });
    fs.writeFileSync(safePath.join(project, '.rag-db'), 'not a database');

    const outcome = await runRag(['stats'], project);

    expect(outcome).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });
    expect(String(outcome.message)).toContain('not a directory');
    expect(String(outcome.message)).not.toContain('No data indexed');
  });

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
      { cwd: suite.projectDir, env: scratchTmp() }
    );

    expect(result.status).toBe(0);
    expect(RAG_CLEAR_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'ok', examined: 1, data: { cleared: true } });

    // Verify database directory is deleted
    expect(fs.existsSync(suite.dbPath)).toBe(false);
  });
});
