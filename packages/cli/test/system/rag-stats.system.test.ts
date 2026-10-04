/**
 * System tests for rag stats command
 *
 * Tests the `vat rag stats` command which displays database statistics
 * including total chunks, resources, and embedding model information.
 */

import { chmodSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';

import { RAG_STATS_REPORT_SCHEMA } from '../../src/commands/rag/admin-schema.js';

import {
  describe,
  executeCliAndParseYaml,
  executeRagCommandInEmptyProject,
  expect,
  fs,
  getBinPath,
  getTestOutputDir,
  it,
  setupRagTestSuite,
} from './rag-test-setup.js';

const binPath = getBinPath(import.meta.url);
const suite = setupRagTestSuite('stats', binPath, getTestOutputDir);

/** Run `vat rag <args> --db <dbPath>` and return the exit code and the published refusal code. */
async function refusalOf(args: string[], dbPath: string): Promise<{ exit: number | null; code: unknown }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, ['rag', ...args, '--db', dbPath], { cwd: suite.projectDir });
  return { exit: result.status, code: (parsed['error'] as { code?: unknown } | undefined)?.code };
}

describe('RAG stats command (system test)', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('should show RAG database statistics', async () => {
    const { result, parsed } = await executeCliAndParseYaml(
      binPath,
      ['rag', 'stats', '--db', suite.dbPath],
      { cwd: suite.projectDir }
    );

    const report = RAG_STATS_REPORT_SCHEMA.parse(parsed);
    expect(result.status).toBe(0);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(report.data?.totalChunks).toBeGreaterThan(0);
    expect(report.data?.totalResources).toBeGreaterThan(0);
    expect(report.data?.embeddingModel).not.toBe('');
    expect(Number.isNaN(Date.parse(report.data?.lastIndexed ?? ''))).toBe(false);
  });

  // The project has no database at all: there is nothing to report on, and zeros would be an invented answer.
  it('refuses a project nothing was indexed for as INPUT_UNREADABLE, exit 2', () => {
    const { result, parsed } = executeRagCommandInEmptyProject(
      suite.tempDir,
      binPath,
      ['rag', 'stats']
    );

    expect(result.status).toBe(2);
    expect(RAG_STATS_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' }, data: null });
  });

  // A mistyped --db is the invocation's mistake. Opening it used to CREATE the
  // directory and publish `ok` — zeros, or `cleared: true` — for a database that never existed.
  it.each([
    ['stats', ['stats']],
    ['query', ['query', 'anything']],
    ['clear', ['clear']],
  ])('rag %s --db <never created> is USAGE_INVALID, exit 2, and creates nothing', async (verb, args) => {
    const neverCreated = safePath.join(suite.tempDir, `never-created-${verb}`);

    expect(await refusalOf(args, neverCreated)).toEqual({ exit: 2, code: 'USAGE_INVALID' });
    expect(fs.existsSync(neverCreated)).toBe(false);
  });

  it('rag stats --db <a file> is USAGE_INVALID: a database is a directory', async () => {
    const aFile = safePath.join(suite.tempDir, 'a-file.db');
    fs.writeFileSync(aFile, 'not a database');

    expect(await refusalOf(['stats'], aFile)).toEqual({ exit: 2, code: 'USAGE_INVALID' });
  });

  // Needs a directory whose mode denies listing it; Windows and root cannot deny that by mode.
  it.skipIf(CANNOT_DENY_READS)('rag stats --db <a directory the OS will not list> is INPUT_UNREADABLE, never a defect in VAT', async () => {
    const locked = safePath.join(suite.tempDir, 'locked-db');
    mkdirSyncReal(locked, { recursive: true });
    chmodSync(locked, 0o000);

    try {
      expect(await refusalOf(['stats'], locked)).toEqual({ exit: 2, code: 'INPUT_UNREADABLE' });
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
