/**
 * A stored-document question never waits on another process's lock on the
 * projection store, with the real SQLite backend.
 *
 * The question (`RunPopulation.storedDocument`) is optional: a lane answered
 * nothing reads the file itself. So when another process holds the store's
 * write lock, the question's open, and the home population it builds, answers
 * at once with nothing, counted `skillText.storeUnopened`, instead of waiting
 * out the store's busy timeout the way a verb's own enumeration does.
 *
 * The lock is held by a child process (an in-process holder would be blocked by
 * the synchronous wait it is testing), and given back only when the test asks,
 * after it has observed the question's outcome: nothing here reads a clock or
 * waits on a deadline. What makes the real backend's contention reach the
 * question as an expected failure (coded, answered with nothing) is asserted
 * here; that the questions' connection waits no time for the lock (its busy
 * timeout is zero) is pinned where the open is scripted,
 * `stored-document-question-store.integration.test.ts`.
 *
 * The same answer for a read-only store directory with no database file yet,
 * where SQLite cannot create one (`SQLITE_CANTOPEN`): a question-only verb
 * reads the file itself rather than refusing.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, defaultStoreDirectory, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { mkdirSyncReal, readWorkCounters, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { detachGitEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetUnscopedNoticeLedger } from '../../src/utils/operator-notices.js';
import { PROJECTION_STORE_ENV } from '../../src/utils/projection-store.js';
import { NO_HOME_SETTLED_LISTENER, withRunContext } from '../../src/utils/resource-loader.js';
import { createTempDirTracker } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo } from '../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-stored-document-contention-');

const SKILL = safePath.join('skills', 'demo', 'SKILL.md');
const MEMBERS = { include: ['**/*.md'], exclude: [], ignoredRefusals: 'record' } as const;

/** Holds the store's write lock until told to release it. */
const HOLDER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.argv[1]);
database.exec('BEGIN IMMEDIATE');
process.stdout.write('held\n');
process.stdin.once('data', () => {
  database.exec('COMMIT');
  database.close();
  process.exit(0);
});
`;

/** A child holding the store's write lock until {@link LockHolder.release}. */
interface LockHolder {
  readonly release: () => Promise<void>;
}

/** Start a child holding the write lock on the store's database, once it holds it. */
async function holdWriteLock(): Promise<LockHolder> {
  const databasePath = safePath.join(defaultStoreDirectory(), 'projection.db');
  const child: ChildProcess = spawn(process.execPath, ['-e', HOLDER, databasePath], { stdio: ['pipe', 'pipe', 'inherit'] });
  let output = '';
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('held\n')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`the lock holder exited (${String(code)}) before holding the lock: ${output}`)));
  });
  return {
    release: async () => {
      child.stdin?.end('release\n');
      await exited;
    },
  };
}

/** A fresh repository holding one skill. */
function makeRepo(): string {
  const root = safePath.join(createTempDir(), 'repo');
  mkdirSyncReal(safePath.join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(safePath.join(root, SKILL), '---\nname: demo\ndescription: A skill the contention test asks about.\n---\n\n# Demo\n', 'utf-8');
  initTestGitRepo(root);
  gitAddAll(root);
  return root;
}

let restoreGitEnv: () => void = () => undefined;

beforeEach(() => {
  restoreGitEnv = detachGitEnv();
  resetUnscopedNoticeLedger();
  vi.stubEnv(VAT_CACHE_DIR_ENV, safePath.join(createTempDir(), 'cache'));
  vi.stubEnv(PROJECTION_STORE_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreGitEnv();
});

afterAll(() => {
  cleanupTempDirs();
});

/**
 * Ask the one question under another process's write lock, then (lock given
 * back) enumerate the home as a verb does, in the same run.
 */
async function askUnderLock(root: string): Promise<{ answer: unknown; unopened: number; enumerated: number }> {
  const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];
  return withRunContext({ projectionStore: 'on-demand', root, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, async (run) => {
    const holder = await holdWriteLock();
    let answer: unknown;
    try {
      answer = await run.population.source.storedDocument(safePath.join(root, SKILL), 'markdown');
    } finally {
      await holder.release();
    }
    const unopened = readWorkCounters()['skillText.storeUnopened'] - unopenedBefore;
    // The verb's own enumeration, lock given back: it opens and builds the home
    // itself, never handed the question's failure.
    const enumerated = await run.population.source.enumerate(root, [], 'refuse', MEMBERS);
    return { answer, unopened, enumerated: enumerated.paths.length };
  });
}

/**
 * The question answered nothing while the other process still held the lock
 * (it is given back only after), counted, and the verb's own enumeration still
 * built the home.
 */
function expectAnsweredUnderLock(result: Awaited<ReturnType<typeof askUnderLock>>): void {
  expect(result.answer).toBeUndefined();
  expect(result.unopened, 'the question counted its failed opening').toBe(1);
  expect(result.enumerated).toBeGreaterThan(0);
}

describe('a stored-document question under another process\'s write lock', () => {
  it('answers nothing from a cold store, and the verb\'s enumeration still builds the home', async () => {
    // A store that exists and holds nothing. Opening a connection configures it
    // (`PRAGMA auto_vacuum` takes the write lock), so the open is what meets it.
    await openSqliteFactStore({ blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES }).close();
    const result = await askUnderLock(makeRepo());

    expectAnsweredUnderLock(result);
  });

  it('answers nothing from a warm store, and the verb\'s enumeration still serves the home', async () => {
    const root = makeRepo();
    // A first run files this tree's facts: the question would be a hit, if it waited.
    await withRunContext({ projectionStore: 'on-demand', root, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, (run) => run.population.source.enumerate(root, [], 'refuse', MEMBERS));

    const result = await askUnderLock(root);

    expectAnsweredUnderLock(result);
  });
});

/**
 * 🪤 Skipped on Windows, where a directory's mode cannot forbid creating a file
 * in it, and as root, whom no mode refuses: the premise is never met.
 */
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a stored-document question over a read-only store directory with no database', () => {
  let storeDirectory: string | undefined;

  afterEach(() => {
    if (storeDirectory !== undefined) chmodSync(storeDirectory, 0o700);
    storeDirectory = undefined;
  });

  it('answers nothing, so the lane reads the file itself', async () => {
    const root = makeRepo();
    storeDirectory = defaultStoreDirectory();
    mkdirSyncReal(storeDirectory, { recursive: true, mode: 0o700 });
    chmodSync(storeDirectory, 0o500);
    const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];

    const answer = await withRunContext({ projectionStore: 'on-demand', root, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, (run) =>
      run.population.source.storedDocument(safePath.join(root, SKILL), 'markdown'));

    expect(answer).toBeUndefined();
    expect(readWorkCounters()['skillText.storeUnopened'] - unopenedBefore, 'the question counted its failed opening').toBe(1);
  });
});
