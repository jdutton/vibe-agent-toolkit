/**
 * System tests for rag clear command
 *
 * Tests the `vat rag clear` command which removes all indexed data from
 * the vector database and deletes the database directory.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

import { RAG_CLEAR_REPORT_SCHEMA } from '../../src/commands/rag/admin-schema.js';

import { describe, executeCliAndParseYaml, expect, fs, getBinPath, getTestOutputDir, it, setupRagTestSuite } from './rag-test-setup.js';
import { setupTestProject } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('clear', binPath, getTestOutputDir);

/** Run `vat rag <args>` from `cwd` and return the exit code, the published refusal code and its message. */
async function runRag(args: string[], cwd: string): Promise<{ exit: number | null; code: unknown; message: unknown }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, ['rag', ...args], { cwd });
  const error = parsed['error'] as { code?: unknown; message?: unknown } | undefined;
  return { exit: result.status, code: error?.code, message: error?.message };
}

/** Overwrite every file under `dir` with bytes LanceDB cannot read, keeping the tree's shape. */
function corrupt(dir: string): void {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    // A database LanceDB wrote holds no links; one would be written through, outside `dir`.
    if (entry.isSymbolicLink()) throw new Error(`unexpected link in a RAG database: ${entry.name}`);
    if (entry.isFile()) fs.writeFileSync(safePath.join(entry.parentPath, entry.name), 'garbage');
  }
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
    const corrupted = safePath.join(suite.tempDir, 'corrupt-db');
    fs.cpSync(suite.dbPath, corrupted, { recursive: true });
    corrupt(corrupted);

    expect(await runRag(['stats', '--db', corrupted], suite.projectDir)).toMatchObject({ exit: 2, code: 'INPUT_UNREADABLE' });

    const { result, parsed } = await executeCliAndParseYaml(binPath, ['rag', 'clear', '--db', corrupted], { cwd: suite.projectDir });
    expect(result.status).toBe(0);
    expect(RAG_CLEAR_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'ok', data: { cleared: true } });
    expect(fs.existsSync(corrupted)).toBe(false);
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
      { cwd: suite.projectDir }
    );

    expect(result.status).toBe(0);
    expect(RAG_CLEAR_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'ok', examined: 1, data: { cleared: true } });

    // Verify database directory is deleted
    expect(fs.existsSync(suite.dbPath)).toBe(false);
  });
});
