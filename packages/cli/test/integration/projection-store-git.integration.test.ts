/**
 * `projection-store` over REAL git repositories — every case that keys a tree.
 *
 * The unit suite (`test/utils/projection-store.test.ts`) owns the wiring that
 * needs no repository: the selector, the decline, the version floor, and every
 * path that returns before a key is derived. Everything here selects the store
 * over a fixture repository, so each case spawns `git write-tree` against a
 * real index — integration-tier cost, and the reason these cases live here.
 *
 * The backend is still the shared fake (`../projection-store-test-doubles.js`):
 * what is under test is the wiring, not the storage engine, and
 * `@vibe-agent-toolkit/projection-sqlite` has its own suites. `gitTreeSnapshot`
 * is REAL and unmocked: a stub returning a canned hash would make the
 * determinism test vacuous — it would prove the stub returns a constant, not
 * that `git write-tree` carries no timestamp.
 */

import { rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { gitTreeSnapshot } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { backend, isolateProjectionStoreTests, lastStore } from '../projection-store-test-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo } from '../test-helpers.js';

/**
 * 🪤 Registered for the specifier so the seam resolves whether or not the
 * workspace link is installed, and so this file keeps testing the wiring, not
 * the engine. See the unit suite's note on the same mock.
 */
vi.mock('@vibe-agent-toolkit/projection-sqlite', async () =>
  (await import('../projection-store-test-doubles.js')).backend.moduleExports());

const {
  CACHE_ENV,
  openPopulationCache,
  PROJECTION_STORE_DIR_ENV,
  PROJECTION_STORE_ENV,
  PROJECTION_STORE_SQLITE,
  withPopulationCache,
} = await import('../../src/utils/projection-store.js');
const { resetUnscopedNoticeLedger } = await import('../../src/utils/operator-notices.js');

/**
 * The repo's own temp-dir helper, which realpaths the OS tmpdir.
 *
 * Not a bare `mkdtemp(tmpdir())`: macOS hands out `/var/...` for a directory git
 * reports as `/private/var/...`, and Windows hands out an 8.3 short name. Either
 * makes the fixtures compare two spellings of one directory and fail for a
 * reason that has nothing to do with the subject.
 */
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-projection-store-git-');

/** Fixture content, written twice on purpose — see the determinism test. */
const FIXTURE_DOC = '# a document\n';

let repoRoot: string;
let secondRepoRoot: string;

beforeAll(() => {
  const scratch = createTempDir();

  repoRoot = safePath.join(scratch, 'repo');
  mkdirSyncReal(repoRoot, { recursive: true });
  writeFileSync(safePath.join(repoRoot, 'doc.md'), FIXTURE_DOC, 'utf-8');
  initTestGitRepo(repoRoot);
  gitAddAll(repoRoot);

  // A SECOND repository, a sibling of the first so git cannot resolve one from
  // the other, holding DIFFERENT content so its tree hash genuinely differs.
  // Identical content would produce the identical hash — `git write-tree` is a
  // function of contents alone — and the nesting test would then pass for a
  // build that reused the outer store blindly.
  secondRepoRoot = safePath.join(scratch, 'other-repo');
  mkdirSyncReal(secondRepoRoot, { recursive: true });
  writeFileSync(safePath.join(secondRepoRoot, 'doc.md'), '# a different document\n', 'utf-8');
  initTestGitRepo(secondRepoRoot);
  gitAddAll(secondRepoRoot);
});

afterAll(() => {
  cleanupTempDirs();
});

isolateProjectionStoreTests({
  envNames: [PROJECTION_STORE_ENV, CACHE_ENV, PROJECTION_STORE_DIR_ENV],
  resetUnscopedNoticeLedger,
});

describe('openPopulationCache', () => {
  it("returns a cache keyed by the repository's git tree hash, and a close that releases the store", async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    const opened = await openPopulationCache({ root: repoRoot });

    expect(opened).toBeDefined();
    // Asserted against a fresh reading of the real snapshot rather than against
    // a literal: the hash is a property of the fixture's contents, and pinning
    // a constant here would turn every harmless change to the fixture into a
    // failure that says nothing about the subject.
    const snapshot = gitTreeSnapshot({ cwd: repoRoot });
    expect(snapshot).not.toBeNull();
    expect(opened?.cache.treeHash).toBe(snapshot?.hash);
    expect(opened?.cache.store).toBeDefined();

    // `close` must reach the store, not merely resolve. A closer that forgot to
    // delegate would leave `withPopulationCache`'s whole `finally` inert while
    // every test about it still passed.
    expect(lastStore().isOpen()).toBe(true);
    await opened?.close();
    expect(lastStore().isOpen()).toBe(false);
    expect(lastStore().closeCount()).toBe(1);
  });

  it('keys two calls over byte-identical content to the same tree hash, so the second run can hit', async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    const first = await openPopulationCache({ root: repoRoot });
    await first?.close();

    // Rewritten with the SAME bytes between the two calls. That moves mtime and
    // touches the working tree without changing content, which is the exact
    // discrimination the key has to make: `git write-tree` hashes a tree object,
    // which carries no timestamp, so the answer must not move.
    writeFileSync(safePath.join(repoRoot, 'doc.md'), FIXTURE_DOC, 'utf-8');

    const second = await openPopulationCache({ root: repoRoot });
    await second?.close();

    // 🪤 The `git stash create` alternative would fail exactly here: a stash is
    // a COMMIT, whose object bakes in a wall-clock timestamp, so two calls over
    // identical content agree only if they land in the same second — and every
    // read after that would miss while the cache looked perfectly healthy.
    expect(first?.cache.treeHash).toBe(second?.cache.treeHash);
    expect(first?.cache.treeHash).toMatch(/^[0-9a-f]{40}$/);
  });
});

/**
 * Open one store and hand back the OPTIONS the backend was constructed with.
 *
 * @param value - What `VAT_PROJECTION_STORE_DIR` holds; `undefined` unsets it
 * @returns The single argument `openSqliteProjectionStore` received
 */
async function openedWithStoreDir(value: string | undefined): Promise<unknown> {
  process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
  if (value === undefined) delete process.env[PROJECTION_STORE_DIR_ENV];
  else process.env[PROJECTION_STORE_DIR_ENV] = value;

  const opened = await openPopulationCache({ root: repoRoot });
  await opened?.close();

  // Asserted before the caller inspects the argument: a run that opened no
  // store at all would otherwise hand back `undefined` and compare it happily
  // against nothing.
  expect(backend.openCalls.count).toBe(1);
  return backend.openCalls.options[0];
}

describe('the directory the backend is opened with', () => {
  it('passes the directory VAT_PROJECTION_STORE_DIR names', async () => {
    // 🪤 The ONLY assertion in either projection-store suite that can see the
    // variable being read. Every other test counts opens and inspects stores,
    // and a build that dropped the `directory` argument entirely would pass all
    // of them — while writing the shared default database, which on this
    // machine holds other repositories' link text, heading text and
    // frontmatter. That is the failure the variable exists to prevent, so it is
    // asserted rather than assumed.
    const directory = safePath.join(createTempDir(), 'named-store');

    expect(await openedWithStoreDir(directory)).toStrictEqual({ directory });
  });

  it.each([
    ['unset', undefined],
    ['exported as the empty string', ''],
  ])('lets the backend default the directory when the variable is %s', async (_description, value) => {
    // `toStrictEqual`, not `toEqual`: an explicitly-passed
    // `{ directory: undefined }` is a DIFFERENT argument from `{}` under
    // `exactOptionalPropertyTypes`, and only the second lets the backend apply
    // `defaultStoreDirectory()`. `toEqual` treats the two as equal and would
    // make the module's spread-rather-than-pass note untested.
    //
    // The empty-string arm is not a curiosity: `''` would resolve to the process
    // cwd, so treating it as "unset" is a decision, and an unexported variable
    // and one exported as `''` are the same intent.
    expect(await openedWithStoreDir(value)).toStrictEqual({});
  });
});

describe('withPopulationCache', () => {
  it('closes the store once the work resolves', async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    const result = await withPopulationCache({ root: repoRoot }, async (cache) => {
      expect(cache).toBeDefined();
      expect(lastStore().isOpen()).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(lastStore().isOpen()).toBe(false);
    expect(lastStore().closeCount()).toBe(1);
  });

  it('closes the store when the work throws, and rethrows the original error', async () => {
    // 🪤 This is the whole reason the module offers a scope instead of an
    // `openPopulationCache()` / `close()` pair. Every caller that wrote the pair
    // by hand would eventually forget the `finally`, and the symptom is not a
    // failed command — the command fails anyway — but a leaked file handle and,
    // in WAL mode, a read transaction pinned to a stale snapshot, which surfaces
    // later and somewhere else.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    const failure = new Error('the work blew up');

    await expect(
      withPopulationCache({ root: repoRoot }, async () => {
        expect(lastStore().isOpen()).toBe(true);
        throw failure;
      }),
    ).rejects.toBe(failure);

    // Rethrown by identity, not merely by message: the caller above must be able
    // to branch on the error it actually threw, and a scope that wrapped or
    // replaced it would take that away.
    expect(lastStore().isOpen()).toBe(false);
    expect(lastStore().closeCount()).toBe(1);
  });

  it('keeps the store open for a population source built in an earlier frame', async () => {
    // The inventory extractor MEMOIZES its population provider: the frame that
    // builds the source returns long before anything reads through it. A scope
    // that closed at the end of the building frame would close the store under
    // its own consumer, and a test that used the cache immediately would never
    // see it — which is why the two calls below are deliberately separated by a
    // returned frame rather than run back to back.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    await withPopulationCache({ root: repoRoot }, async (cache) => {
      expect(cache).toBeDefined();

      // Stands in for `buildPopulationSource(cache)`: it captures the cache and
      // returns, so its own frame is gone by the time the provider is reached.
      const buildProvider = (): (() => Promise<unknown>) => {
        const captured = cache;
        return async () => captured?.store.readExtent({ rootId: 'r', treeHash: captured.treeHash });
      };
      const provider = buildProvider();

      // A closed fake throws here, so this line is a real gate rather than a
      // formality — see the fake's note on why a permissive double would make
      // the lifetime bug invisible.
      await expect(provider()).resolves.toBeUndefined();
      expect(lastStore().isOpen()).toBe(true);
    });

    expect(lastStore().isOpen()).toBe(false);
  });

  it('is reentrant: a nested scope over the same repository reuses the open store', async () => {
    // 🔑 The property that lets `vat validate` hoist ONE bracket over every
    // phase without rewriting the lanes underneath. Each lane still opens its
    // own scope — `resource-loader`'s two, `inventory`, `claude/context`,
    // `claude/budget` — and each one now finds the orchestrator's scope already
    // open and joins it instead of opening a second database and taking a
    // second `git write-tree`.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    const inner = await withPopulationCache({ root: repoRoot }, async (outerCache) => {
      expect(outerCache).toBeDefined();
      return withPopulationCache({ root: repoRoot }, async (innerCache) => {
        // The SAME cache, by identity. An inner scope that opened a second
        // store over the same file would also "work" — and would pay a second
        // open, a second snapshot, and hold two connections to one WAL
        // database.
        expect(innerCache).toBe(outerCache);
        // Still open INSIDE the inner scope, which is the half that catches the
        // obvious wrong implementation: an inner scope that closed what it
        // reused.
        expect(lastStore().isOpen()).toBe(true);
        return innerCache;
      });
    });

    expect(inner).toBeDefined();
    expect(backend.openCalls.count).toBe(1);
    // Closed exactly once, by the scope that opened it. Twice would mean the
    // inner scope closed a store it did not own; zero would be a leak.
    expect(lastStore().isOpen()).toBe(false);
    expect(lastStore().closeCount()).toBe(1);
  });

  it('opens its own store for a nested scope rooted in a DIFFERENT repository', async () => {
    // The positive control on the reuse above, and the whole reason reuse is
    // gated on the TREE HASH rather than on "a scope is open". A stored extent
    // is filed under `(rootId, treeHash)`; handing a lane in another repository
    // this repository's hash would file its extent under a key that does not
    // describe it — the same silent mis-keying the git-snapshot bracket exists
    // to prevent, arriving through the hoist instead.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    const hashes = await withPopulationCache({ root: repoRoot }, async (outerCache) =>
      withPopulationCache({ root: secondRepoRoot }, async (innerCache) => ({
        outer: outerCache?.treeHash,
        inner: innerCache?.treeHash,
      })),
    );

    expect(backend.openCalls.count).toBe(2);
    expect(hashes.outer).toMatch(/^[0-9a-f]{40}$/);
    expect(hashes.inner).toMatch(/^[0-9a-f]{40}$/);
    expect(hashes.inner).not.toBe(hashes.outer);
    // Both closed: the inner scope owns the store it opened.
    expect(backend.stores.every((record) => record.closeCount === 1)).toBe(true);
  });

  it('reports a mid-scope edit through treeUnchanged, though the memo still hides it', async () => {
    // The half the bracket below cannot close. The key and the crawl agree with
    // each other; the files the population READS may not agree with either.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    const arrivedLate = safePath.join(repoRoot, 'moved-mid-scope.md');

    try {
      const verdicts = await withPopulationCache({ root: repoRoot }, async (cache) => {
        const before = cache?.treeUnchanged();
        writeFileSync(arrivedLate, '# moved\n', 'utf-8');
        return { before, after: cache?.treeUnchanged(), memo: gitTreeSnapshot({ cwd: repoRoot })?.hash, key: cache?.treeHash };
      });

      expect(verdicts.before).toBe(true);
      expect(verdicts.after).toBe(false);
      // Still the memo's answer — the check went around it, not through it.
      expect(verdicts.memo).toBe(verdicts.key);
    } finally {
      rmSync(arrivedLate, { force: true });
    }
  });

  it('is the git-snapshot bracket, so a mid-scope edit cannot split the key from the extent', async () => {
    // The wiring assertion for `withGitSnapshotCache`. `packages/utils` proves
    // the bracket dedupes; only this file can prove the bracket is OPEN AROUND
    // BOTH consumers — the store's key snapshot and the crawl's entries
    // snapshot. A bracket opened deeper than one of them dedupes nothing and
    // looks exactly like a bracket that works.
    //
    // 🪤 Asserted as BEHAVIOUR, not as a call count. A counter wrapping
    // `gitTreeSnapshot` (the unit suite keeps one) sits where the memo lives —
    // it counts CALLS, and stays 2 whether or not the second one spawned git.
    // The spawn-level count belongs at the `@vibe-validate/git` seam and is
    // asserted there, in
    // `packages/utils/test/integration/git-snapshot-cache.integration.test.ts`.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    const arrivedLate = safePath.join(repoRoot, 'landed-mid-scope.md');

    try {
      const keyed = await withPopulationCache({ root: repoRoot }, async (cache) => {
        // The race, made deliberate: unbracketed, the crawl inside `work` takes
        // its own snapshot ~195 ms after the key was derived, and an edit
        // landing in between files THIS extent under THAT key.
        writeFileSync(arrivedLate, '# late\n', 'utf-8');
        // Stands in for `GitCrawlSource.#snapshotMembers`.
        const crawled = gitTreeSnapshot({ cwd: repoRoot });
        return { treeHash: cache?.treeHash, crawledHash: crawled?.hash };
      });

      expect(keyed.treeHash).toMatch(/^[0-9a-f]{40}$/);
      expect(keyed.crawledHash).toBe(keyed.treeHash);

      // And the edit was REAL: outside the scope the hash moves. Without this
      // the assertion above would also hold for a mutation git never noticed,
      // which is the shape that makes a race test pass while proving nothing.
      expect(gitTreeSnapshot({ cwd: repoRoot })?.hash).not.toBe(keyed.treeHash);
    } finally {
      // The fixture repo is shared by every test in this file, so the edit is
      // undone rather than left for whatever runs next.
      rmSync(arrivedLate, { force: true });
    }
  });
});
