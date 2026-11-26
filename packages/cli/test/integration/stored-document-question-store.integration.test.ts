/**
 * The stored-document questions' own connection to the projection store
 * (`openQuestionCache`), through the scripted backend: it waits no time for a
 * lock, codes every failure the question expects (another process's lock, a
 * read-only cache) as `StoreQuestionUnavailableError` so the population answers
 * the question with nothing, leaves every other failure as itself, and closes
 * through the same contract as the run's own connection.
 *
 * The real backend under a real lock is `stored-document-contention.integration.test.ts`;
 * a damaged file met by this connection is `projection-store-damaged.integration.test.ts`.
 */

import { writeFileSync } from 'node:fs';

import { ALL_EXTENT_REQUEST, emptyBlobRows, StoreQuestionUnavailableError } from '@vibe-agent-toolkit/resources';
import { uncoveredBlobWrite } from '@vibe-agent-toolkit/resources/testing';
import { mkdirSyncReal, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { backend, captureStderr, FAKE_BLOB_TIER_BUDGET_BYTES, FakeUnavailableNowError, isolateProjectionStoreTests } from '../projection-store-test-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo } from '../test-helpers.js';

vi.mock('@vibe-agent-toolkit/projection-sqlite', async () =>
  (await import('../projection-store-test-doubles.js')).backend.moduleExports());

const { CACHE_ENV, openQuestionCache, PROJECTION_STORE_ENV, PROJECTION_STORE_SQLITE } = await import('../../src/utils/projection-store.js');
const { NO_HOME_SETTLED_LISTENER, withRunContext } = await import('../../src/utils/resource-loader.js');
const { resetUnscopedNoticeLedger } = await import('../../src/utils/operator-notices.js');

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-question-store-');

let repoRoot: string;

beforeAll(() => {
  repoRoot = safePath.join(createTempDir(), 'repo');
  mkdirSyncReal(safePath.join(repoRoot, 'skills', 'demo'), { recursive: true });
  writeFileSync(safePath.join(repoRoot, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A skill.\n---\n\n# Demo\n', 'utf-8');
  initTestGitRepo(repoRoot);
  gitAddAll(repoRoot);
});

afterAll(() => {
  cleanupTempDirs();
});

isolateProjectionStoreTests({
  envNames: [PROJECTION_STORE_ENV, CACHE_ENV, VAT_CACHE_DIR_ENV],
  resetUnscopedNoticeLedger,
});

/** What opening the questions' connection settled with: its rejection, or the opened cache. */
async function openQuestion(): Promise<unknown> {
  process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
  return openQuestionCache({ root: repoRoot }).then(async (opened) => {
    await opened?.close();
    return opened;
  }, (error: unknown) => error);
}

/** A read-only cache directory, as `mkdir` refuses it. */
function accessRefused(): Error {
  return Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES', errno: -13, syscall: 'mkdir' });
}

/**
 * A read-only filesystem under the cache, as `mkdir` refuses it: an errno the
 * table classes `unsupported`, not `refused`. A real one cannot be made in a test.
 */
function readOnlyFilesystem(): Error {
  return Object.assign(new Error('EROFS: read-only file system, mkdir'), { code: 'EROFS', errno: -30, syscall: 'mkdir' });
}

/** A SQLite refusal the store does not expect at close: a full disk under the checkpoint. */
function diskFull(): Error {
  return Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
}

describe('the stored-document questions\' connection', () => {
  it('opens with a busy timeout of zero, so another process\'s lock refuses at once', async () => {
    await openQuestion();
    expect(backend.openCalls.options).toStrictEqual([{ busyTimeoutMs: 0, blobTierBudgetBytes: FAKE_BLOB_TIER_BUDGET_BYTES }]);
  });

  it.each([
    ['another process\'s lock, as the backend names it', () => new FakeUnavailableNowError()],
    ['a read-only cache directory', accessRefused],
    ['a read-only filesystem', readOnlyFilesystem],
  ])('codes an open the question expects to fail (%s) as the store unable to answer now', async (_case, fault) => {
    const raised = fault();
    backend.openFailures.push(raised);
    const opened = await openQuestion();
    expect(opened).toBeInstanceOf(StoreQuestionUnavailableError);
    expect((opened as Error).cause).toBe(raised);
  });

  it.each([
    ['a defect in the backend', () => new Error('a defect in the backend')],
    ['an unsupported filesystem operation other than a read-only filesystem', () =>
      Object.assign(new Error('ENOTSUP: operation not supported, mkdir'), { code: 'ENOTSUP', errno: -45, syscall: 'mkdir' })],
  ])('leaves every other open failure as itself (%s)', async (_case, fault) => {
    const raised = fault();
    backend.openFailures.push(raised);
    expect(await openQuestion()).toBe(raised);
  });

  it('codes a store call the question expects to fail as the store unable to answer now, and leaves the rest as themselves', async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    const opened = await openQuestionCache({ root: repoRoot });
    try {
      const locked = new FakeUnavailableNowError();
      const defect = new Error('a defect in the backend');
      backend.callFailures.push(locked, defect);
      const store = opened?.cache.store;
      const first = await store?.writeBlobFacts(uncoveredBlobWrite(emptyBlobRows())).then(() => undefined, (error: unknown) => error);
      const second = await store?.readExtent({ rootId: 'r', treeHash: 'h' }, ALL_EXTENT_REQUEST).then(() => undefined, (error: unknown) => error);
      expect(first).toBeInstanceOf(StoreQuestionUnavailableError);
      expect((first as Error).cause).toBe(locked);
      expect(second).toBe(defect);
    } finally {
      await opened?.close();
    }
  });
});

/** Run a verb that asks one stored-document question, its question connection's close failing with `closeFault`. */
async function runAsking(work: () => Promise<number>, closeFault: Error): Promise<{ settled: unknown; stderr: string }> {
  process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
  // The question's connection is the first opened, and the only one this run opens.
  backend.closeFailures.push(closeFault);
  const capture = captureStderr();
  try {
    const settled = await withRunContext({ projectionStore: 'on-demand', root: repoRoot, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, async (run) => {
      await run.population.source.storedDocument(safePath.join(repoRoot, 'skills', 'demo', 'SKILL.md'), 'markdown');
      return work();
    }).then((value) => value, (error: unknown) => error);
    return { settled, stderr: capture.written.join('') };
  } finally {
    capture.restore();
  }
}

describe('closing the questions\' connection at the end of a run', () => {
  it('keeps a finished run\'s result when only the close fails, and warns', async () => {
    const { settled, stderr } = await runAsking(() => Promise.resolve(42), diskFull());
    expect(backend.openCalls.count, 'premise: only the question\'s connection opened').toBe(1);
    expect(settled).toBe(42);
    expect(stderr).toMatch(/did not close cleanly.*database or disk is full/u);
  });

  it('reports the run\'s own failure when the close fails too, naming the close failure', async () => {
    const failure = new Error('the verb failed');
    const { settled, stderr } = await runAsking(() => Promise.reject(failure), diskFull());
    expect(settled).toBe(failure);
    expect(stderr).toMatch(/did not close cleanly.*database or disk is full/u);
  });
});
