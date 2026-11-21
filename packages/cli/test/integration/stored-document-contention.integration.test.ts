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
 * the synchronous wait it is testing). The child gives the lock back on its own
 * after {@link SELF_RELEASE_MS}, inside the store's busy timeout: a question that
 * waits therefore gets the lock and builds the home, so it counts no failure and
 * answers after the child released. Neither assertion reads a clock.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { defaultStoreDirectory, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { detachGitEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetUnscopedNoticeLedger } from '../../src/utils/operator-notices.js';
import { PROJECTION_STORE_ENV } from '../../src/utils/projection-store.js';
import { withRunContext } from '../../src/utils/resource-loader.js';
import { createTempDirTracker } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo } from '../test-helpers.js';

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-stored-document-contention-');

/** How long the holder keeps the lock unless told to give it back: inside the store's 5,000 ms busy timeout. */
const SELF_RELEASE_MS = 2500;

const SKILL = safePath.join('skills', 'demo', 'SKILL.md');
const MEMBERS = { include: ['**/*.md'], exclude: [], ignoredRefusals: 'record' } as const;

/** Holds the store's write lock until told to release it, or until {@link SELF_RELEASE_MS}. */
const HOLDER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.argv[1]);
database.exec('BEGIN IMMEDIATE');
process.stdout.write('held\n');
let done = false;
const release = () => {
  if (done) return;
  done = true;
  database.exec('COMMIT');
  database.close();
  process.stdout.write('released\n');
  process.exit(0);
};
process.stdin.on('data', release);
setTimeout(release, Number(process.argv[2]));
`;

/** A child holding the store's write lock, and whether it has given it back. */
interface LockHolder {
  readonly released: () => boolean;
  readonly release: () => Promise<void>;
}

/** Start a child holding the write lock on the store's database, once it holds it. */
async function holdWriteLock(): Promise<LockHolder> {
  const databasePath = safePath.join(defaultStoreDirectory(), 'projection.db');
  const child: ChildProcess = spawn(process.execPath, ['-e', HOLDER, databasePath, String(SELF_RELEASE_MS)], { stdio: ['pipe', 'pipe', 'inherit'] });
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
    released: () => output.includes('released\n'),
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
async function askUnderLock(root: string): Promise<{ answer: unknown; releasedAtAnswer: boolean; unopened: number; enumerated: number }> {
  const unopenedBefore = readWorkCounters()['skillText.storeUnopened'];
  return withRunContext({ projectionStore: 'on-demand', root, outputs: [] }, async (run) => {
    const holder = await holdWriteLock();
    let answer: unknown;
    let releasedAtAnswer: boolean;
    try {
      answer = await run.population.source.storedDocument(safePath.join(root, SKILL), 'markdown');
      releasedAtAnswer = holder.released();
    } finally {
      await holder.release();
    }
    const unopened = readWorkCounters()['skillText.storeUnopened'] - unopenedBefore;
    // The verb's own enumeration, lock given back: it opens and builds the home
    // itself, never handed the question's failure.
    const enumerated = await run.population.source.enumerate(root, [], 'refuse', MEMBERS);
    return { answer, releasedAtAnswer, unopened, enumerated: enumerated.paths.length };
  });
}

/** The question answered nothing, at once and counted, and the verb's own enumeration still built the home. */
function expectAnsweredAtOnce(result: Awaited<ReturnType<typeof askUnderLock>>): void {
  expect(result.answer).toBeUndefined();
  expect(result.unopened, 'the question counted its failed opening').toBe(1);
  expect(result.releasedAtAnswer, 'answered while the other process still held the lock').toBe(false);
  expect(result.enumerated).toBeGreaterThan(0);
}

describe('a stored-document question under another process\'s write lock', () => {
  it('answers nothing at once from a cold store, and the verb\'s enumeration still builds the home', async () => {
    // A store that exists and holds nothing. Opening a connection configures it
    // (`PRAGMA auto_vacuum` takes the write lock), so the open is what meets it.
    await openSqliteFactStore().close();
    const result = await askUnderLock(makeRepo());

    expectAnsweredAtOnce(result);
  });

  it('answers nothing at once from a warm store, never waiting for the hit, and the verb\'s enumeration still serves the home', async () => {
    const root = makeRepo();
    // A first run files this tree's facts: the question would be a hit, if it waited.
    await withRunContext({ projectionStore: 'on-demand', root, outputs: [] }, (run) => run.population.source.enumerate(root, [], 'refuse', MEMBERS));

    const result = await askUnderLock(root);

    expectAnsweredAtOnce(result);
  });
});
