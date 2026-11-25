/**
 * A damaged `projection.db` under `VAT_CACHE_DIR` is a cache miss, end to end,
 * with the real SQLite backend: the kind of file a CI cache restore can hand a
 * run — garbage bytes, or a database cut short.
 *
 * The scripted-backend arms (discard, replacement failure, other failures
 * surfacing) are in `projection-store-git.integration.test.ts`; this file
 * proves the real backend's refusal is the one the CLI recognises.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { defaultStoreDirectory, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { emptyBlobRows } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { detachGitEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetUnscopedNoticeLedger } from '../../src/utils/operator-notices.js';
import { PROJECTION_STORE_ENV, openPopulationCache, openQuestionCache } from '../../src/utils/projection-store.js';
import { captureStderr } from '../projection-store-test-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo } from '../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-projection-store-damaged-');

let repoRoot: string;
let restoreGitEnv: () => void = () => undefined;

beforeAll(() => {
  repoRoot = safePath.join(createTempDir(), 'repo');
  mkdirSyncReal(repoRoot, { recursive: true });
  writeFileSync(safePath.join(repoRoot, 'doc.md'), '# a document\n', 'utf-8');
  initTestGitRepo(repoRoot);
  gitAddAll(repoRoot);
});

afterAll(() => {
  cleanupTempDirs();
});

beforeEach(() => {
  restoreGitEnv = detachGitEnv();
  resetUnscopedNoticeLedger();
  vi.stubEnv(VAT_CACHE_DIR_ENV, safePath.join(createTempDir(), 'ci-cache'));
  vi.stubEnv(PROJECTION_STORE_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreGitEnv();
});

/** The store's database file under the stubbed cache root. */
function databaseFile(): string {
  return safePath.join(defaultStoreDirectory(), 'projection.db');
}

/** Opens one of the store's connections: the run's own, or its stored-document questions'. */
type Opener = typeof openPopulationCache;

/** Open the population cache, capturing what it told the operator. */
async function openCapturing(open: Opener = openPopulationCache): Promise<{ opened: Awaited<ReturnType<Opener>>; stderr: string }> {
  const capture = captureStderr();
  try {
    const opened = await open({ root: repoRoot });
    return { opened, stderr: capture.written.join('') };
  } finally {
    capture.restore();
  }
}

/** Assert the file at {@link databaseFile} is a healthy SQLite database now. */
function expectHealthyDatabase(): void {
  const check = new DatabaseSync(databaseFile());
  try {
    expect(check.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
  } finally {
    check.close();
  }
}

// The run's own connection and its stored-document questions' (which only waits
// no time for a lock) discard a damaged file alike, so a question-only verb never
// leaves it cold forever.
describe.each([
  ['the run\'s own connection', openPopulationCache],
  ['the stored-document questions\' connection', openQuestionCache],
] as const)('a damaged projection.db under VAT_CACHE_DIR, opened by %s', (_connection, open) => {
  it('replaces a file of garbage with a fresh store, naming the path and SQLite\'s error', async () => {
    mkdirSyncReal(defaultStoreDirectory(), { recursive: true });
    writeFileSync(databaseFile(), Buffer.alloc(8192, 0x5a));

    const { opened, stderr } = await openCapturing(open);
    try {
      expect(opened).toBeDefined();
      expect(stderr).toContain(databaseFile());
      expect(stderr).toMatch(/not a database/u);
    } finally {
      await opened?.close();
    }
    expectHealthyDatabase();
  });

  it('replaces a truncated database with a fresh store', async () => {
    const store = openSqliteFactStore();
    await store.writeBlobFacts(emptyBlobRows());
    await store.close();
    const bytes = readFileSync(databaseFile());
    writeFileSync(databaseFile(), bytes.subarray(0, Math.floor(bytes.length / 2)));

    const { opened, stderr } = await openCapturing(open);
    try {
      expect(opened).toBeDefined();
      expect(stderr).toContain(databaseFile());
      expect(stderr).toMatch(/malformed|not a database/u);
    } finally {
      await opened?.close();
    }
    expectHealthyDatabase();
  });
});

describe('a VAT_CACHE_DIR inside the scanned tree', () => {
  it('is named on stderr, and the run carries on with its store', async () => {
    const inside = safePath.join(repoRoot, '.vat-ci-cache');
    vi.stubEnv(VAT_CACHE_DIR_ENV, inside);

    const { opened, stderr } = await openCapturing();
    try {
      expect(opened).toBeDefined();
      expect(stderr).toContain(`${VAT_CACHE_DIR_ENV} (${inside}) is inside the scanned tree`);
    } finally {
      await opened?.close();
    }
  });

  it('names the default root, not VAT_CACHE_DIR, when the variable is unset and the temp directory is inside the tree', async () => {
    const insideTmp = safePath.join(repoRoot, 'tmp');
    mkdirSyncReal(insideTmp, { recursive: true });
    vi.stubEnv(VAT_CACHE_DIR_ENV, '');
    vi.stubEnv('TMPDIR', insideTmp);
    vi.stubEnv('TEMP', insideTmp);
    vi.stubEnv('TMP', insideTmp);

    const { opened, stderr } = await openCapturing();
    await opened?.close();
    expect(stderr).toContain(`The default cache root (${safePath.join(insideTmp, '.vat-cache')}, under the temp directory) is inside the scanned tree`);
    expect(stderr).toContain(`Set ${VAT_CACHE_DIR_ENV} to a directory outside the checkout`);
  });

  it('is not mentioned when the cache root is outside the tree', async () => {
    const { opened, stderr } = await openCapturing();
    await opened?.close();
    expect(stderr).not.toContain('is inside the scanned tree');
  });
});
