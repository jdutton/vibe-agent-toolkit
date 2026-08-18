/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir this test owns */
/**
 * `projection-store` — selecting a backend, keying a tree, and scoping the
 * store's lifetime.
 *
 * This module is the ONLY place in the toolkit that knows the SQLite backend
 * exists, so what is under test here is the *wiring*, not the storage engine:
 * which env value turns the cache on, where the key comes from, what happens
 * when the key cannot be derived, and who closes the connection. The backend
 * itself is mocked — a unit test that opened a real `node:sqlite` database
 * would be testing `projection-sqlite`, which has its own suites, and would
 * couple this file to whether the workspace link happens to be installed.
 *
 * Three properties carry most of the weight, because each one has a plausible
 * "improvement" that would break it silently:
 *
 * 1. **The selector is read at every call, never memoized.** `vitest.setup.js`
 *    deletes every `VAT_*` variable before any test module loads, so a
 *    module-level `const selected = process.env[...] === 'sqlite'` would be
 *    captured as `false` forever and no test could ever turn the cache on.
 *    Every test below that sets the variable would keep passing while
 *    exercising the uncached path — the "subject that exercises nothing looks
 *    like a clean result" failure the module's own header calls out.
 * 2. **An opted-in cache that declines says so.** A root outside a readable
 *    repository has no deterministic key, so the cache is skipped — but
 *    silently skipping it is exactly how a measurement arm ends up believing it
 *    tested a cache when it tested an ordinary cold run. The `undefined` and
 *    the stderr line are one behaviour, not two, and both are asserted.
 * 3. **The scope closes on the throwing path too.** That is the entire reason
 *    `withPopulationCache` is a scope rather than a bare open/close pair: a
 *    `DatabaseSync` left open holds its file handle and, in WAL mode, its read
 *    transaction.
 */

import { writeFileSync } from 'node:fs';

import type { PopulationCache } from '@vibe-agent-toolkit/resources';
// All three come from the module this file MOCKS, and all three survive it: the
// factory below spreads the real module and replaces exactly one export.
// `gitTreeSnapshot` therefore arrives here as the counting wrapper, which is
// deliberate — it is still the real implementation underneath.
import { gitTreeSnapshot, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
// Type-only, purely so the mock factory can spread the real module without an
// inline `typeof import()` annotation, which this repo's lint forbids.
import type * as UtilsModule from '@vibe-agent-toolkit/utils';
// `./testing` is a DIFFERENT module id, so the mock above does not reach it —
// which is what we want: `detachGitEnv` is the thing that makes the git
// fixtures trustworthy, and a mocked version of it would quietly stop doing so.
import { detachGitEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirTracker } from '../system/test-common.js';
import { gitAddAll, initTestGitRepo } from '../test-helpers.js';

/** A read-only window onto one fake store's lifetime. */
interface FakeStoreHandle {
  /**
   * How many times `close()` reached the store.
   *
   * Counted rather than merely flagged: the real backend promises close is
   * idempotent, which means a double-close in THIS module would leave no trace
   * anywhere else.
   */
  readonly closeCount: () => number;
  /** Whether the connection is still usable — what "the store outlived the frame that built the source" actually means. */
  readonly isOpen: () => boolean;
}

/**
 * The mock backend, and the handle the tests inspect it through.
 *
 * Hoisted because `vi.mock`'s factory is lifted above the imports, so it cannot
 * close over an ordinary module-level binding.
 *
 * 🪤 A closed fake REJECTS every later call rather than quietly succeeding.
 * That mirrors the real contract ("a store that has been closed rejects further
 * calls rather than silently reopening — a reopen would hide a lifetime bug in
 * the caller"), and without it the "still usable later" test below could not
 * fail: a permissive fake answers a closed store's reads happily and the
 * lifetime bug it exists to catch would sail through green.
 */
const backend = vi.hoisted(() => {
  const stores: {
    closeCount: number;
    closed: boolean;
  }[] = [];

  function makeStore(): { record: (typeof stores)[number]; store: unknown } {
    const record = { closeCount: 0, closed: false };
    stores.push(record);
    const refuseIfClosed = (): void => {
      if (record.closed) throw new Error('store is closed');
    };
    return {
      record,
      store: {
        writeBlobFacts: async () => {
          refuseIfClosed();
        },
        readBlobFacts: async () => {
          refuseIfClosed();
          return {};
        },
        writeExtent: async () => {
          refuseIfClosed();
        },
        readExtent: async () => {
          refuseIfClosed();
          return undefined;
        },
        close: async () => {
          record.closeCount += 1;
          record.closed = true;
        },
      },
    };
  }

  return { stores, makeStore, openCalls: { count: 0 } };
});

/**
 * 🪤 `@vibe-agent-toolkit/projection-sqlite` is NOT resolvable from
 * `packages/cli` in this workspace — the link is added in a separate step — so
 * the real `await import()` inside `loadStore()` would raise
 * `ERR_MODULE_NOT_FOUND`, be diagnosed as "backend not installed", and
 * `process.exit(2)` out of the test worker. Registering a factory for the
 * specifier makes the seam resolvable regardless, which is also what we want
 * once the link DOES land: this file should keep testing the wiring, not the
 * engine, and should not start or stop passing because of an install decision.
 */
vi.mock('@vibe-agent-toolkit/projection-sqlite', () => ({
  openSqliteProjectionStore: () => {
    backend.openCalls.count += 1;
    return backend.makeStore().store;
  },
}));

/**
 * `gitTreeSnapshot` is left REAL and merely counted.
 *
 * A stub returning a canned hash would make the determinism test vacuous — it
 * would prove the stub returns a constant, not that `git write-tree` carries no
 * timestamp. The counter exists for one assertion only: that a process with no
 * store selected returns before the key is even derived, which is upstream of
 * the dynamic import and is therefore the cheapest observable proof the lazy
 * seam is intact.
 */
const git = vi.hoisted(() => ({ calls: { count: 0 } }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>();
  return {
    ...actual,
    gitTreeSnapshot: (options: { cwd: string }) => {
      git.calls.count += 1;
      return actual.gitTreeSnapshot(options);
    },
  };
});

const {
  openPopulationCache,
  PROJECTION_STORE_ENV,
  PROJECTION_STORE_SQLITE,
  projectionStoreSelected,
  withPopulationCache,
} = await import('../../src/utils/projection-store.js');

/**
 * The most recently opened fake store, as a lifetime handle.
 *
 * Throws rather than returning `undefined` when nothing was opened: a test that
 * expected a store and got none must fail on that fact, not slide into
 * comparing `undefined` against `undefined` and pass.
 */
function lastStore(): FakeStoreHandle {
  const record = backend.stores.at(-1);
  if (record === undefined) throw new Error('no store was opened');
  return {
    closeCount: () => record.closeCount,
    isOpen: () => !record.closed,
  };
}

/** Capture everything written to stderr for one call. */
function captureStderr(): { readonly written: string[]; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { written, restore: () => spy.mockRestore() };
}

/**
 * The repo's own temp-dir helper, which realpaths the OS tmpdir.
 *
 * Not a bare `mkdtemp(tmpdir())`: macOS hands out `/var/...` for a directory git
 * reports as `/private/var/...`, and Windows hands out an 8.3 short name. Either
 * makes the fixtures compare two spellings of one directory and fail for a
 * reason that has nothing to do with the subject.
 */
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-projection-store-');

/** Fixture content, written twice on purpose — see the determinism test. */
const FIXTURE_DOC = '# a document\n';

let repoRoot: string;
let outsideAnyRepo: string;

beforeAll(() => {
  const scratch = createTempDir();

  repoRoot = safePath.join(scratch, 'repo');
  mkdirSyncReal(repoRoot, { recursive: true });
  writeFileSync(safePath.join(repoRoot, 'doc.md'), FIXTURE_DOC, 'utf-8');
  initTestGitRepo(repoRoot);
  gitAddAll(repoRoot);

  // A plain directory with no repository above it. It is a SIBLING of the
  // fixture repo, never a child: git resolves upward, so a nested directory
  // would find `repoRoot` and this arm would assert the opposite of what it
  // claims while still going green.
  outsideAnyRepo = safePath.join(scratch, 'not-a-repo');
  mkdirSyncReal(outsideAnyRepo, { recursive: true });
});

afterAll(() => {
  cleanupTempDirs();
});

let restoreGitEnv: () => void;
let savedSelector: string | undefined;

beforeEach(() => {
  // 🪤 A git child inherits `GIT_DIR` / `GIT_INDEX_FILE` from whatever spawned
  // this run — a hook, an outer `vat validate` — and would then snapshot the
  // OUTER repository while the fixture sat untouched. Both fixtures depend on
  // git resolving from the directory it is given and nowhere else.
  restoreGitEnv = detachGitEnv();
  savedSelector = process.env[PROJECTION_STORE_ENV];
  backend.stores.length = 0;
  backend.openCalls.count = 0;
  git.calls.count = 0;
});

afterEach(() => {
  // Restored rather than deleted: the selector is process-global, and a test
  // that leaks it turns every later test in the same worker into a different
  // test. "Passes in isolation, fails in the suite" is the signature.
  delete process.env[PROJECTION_STORE_ENV];
  if (savedSelector !== undefined) process.env[PROJECTION_STORE_ENV] = savedSelector;
  restoreGitEnv();
  vi.restoreAllMocks();
});

describe('projectionStoreSelected', () => {
  it('is false when the selector is not set at all', () => {
    // The default, and the one that matters most: a cache changes no answer, so
    // it stays off until someone measured the win and asked for it.
    expect(process.env[PROJECTION_STORE_ENV]).toBeUndefined();
    expect(projectionStoreSelected()).toBe(false);
  });

  it('is true for the exact value that names the SQLite backend', () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;

    expect(projectionStoreSelected()).toBe(true);
  });

  it.each([
    ['an empty value', ''],
    ['a backend that does not exist', 'duckdb'],
    ['a case variant', 'SQLite'],
    ['the right word with stray whitespace', ' sqlite'],
    ['a truthy-looking value', '1'],
  ])('is false for %s', (_description, value) => {
    // Exact-match, not truthiness. `VAT_PROJECTION_STORE=1` reads like an
    // enable flag and is not one — an operator who wrote it would otherwise get
    // a store nobody named, and the day a second backend exists the value is
    // the only thing distinguishing them.
    process.env[PROJECTION_STORE_ENV] = value;

    expect(projectionStoreSelected()).toBe(false);
  });

  it('reads the environment on every call rather than memoizing it at module load', () => {
    // 🪤 THE load-bearing test in this file. `vitest.setup.js` deletes every
    // `VAT_*` variable before any test module is loaded, so a module-level
    // binding would be captured as `false` and could never be turned on again.
    // Every other test here that sets the selector would then pass while
    // silently exercising the UNCACHED path, and the whole suite would be a
    // clean result over a subject that does nothing. Watching the answer move
    // under a live process is the only way to see that; a single call, however
    // it is arranged, cannot.
    expect(projectionStoreSelected()).toBe(false);

    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    expect(projectionStoreSelected()).toBe(true);

    process.env[PROJECTION_STORE_ENV] = 'something-else';
    expect(projectionStoreSelected()).toBe(false);

    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    expect(projectionStoreSelected()).toBe(true);
  });
});

describe('openPopulationCache', () => {
  it('returns undefined without keying the tree or opening a backend when no store is selected', async () => {
    const opened = await openPopulationCache({ root: repoRoot });

    expect(opened).toBeUndefined();
    // The lazy seam, observed from both sides. `gitTreeSnapshot` runs BEFORE the
    // dynamic import in the one path that reaches it, so a zero snapshot count
    // proves the function returned upstream of anywhere the import could be
    // reached; the zero open count says the backend was never constructed. A
    // command that pays for the store's module graph while not using a store is
    // the cost this whole seam exists to avoid, and nothing else would notice.
    expect(git.calls.count).toBe(0);
    expect(backend.openCalls.count).toBe(0);
  });

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

  it('declines out loud on stderr when the selector is set but the root is not inside a readable git repository', async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    const stderr = captureStderr();
    try {
      const opened = await openPopulationCache({ root: outsideAnyRepo });

      // BOTH halves are the behaviour. The `undefined` alone would be a cache
      // that was asked for and quietly did not appear — the failure mode the
      // module's header names, and the one that already cost this project a
      // whole A/B: the arm believes it is measuring a cache and is measuring an
      // ordinary cold run, which looks like a clean result rather than a bug.
      expect(opened).toBeUndefined();

      const said = stderr.written.join('');
      expect(said).toContain(PROJECTION_STORE_ENV);
      expect(said).toContain(outsideAnyRepo);
      expect(said).toContain('not inside a readable git repository');
      // Names the consequence too, so the reader knows the run is still correct
      // and only slower — this is an explanation, not an error.
      expect(said).toContain('without a cache');

      // And it costs nothing: the backend is never loaded for a tree that
      // cannot be keyed, which is why the git call is placed before the import.
      expect(backend.openCalls.count).toBe(0);
    } finally {
      stderr.restore();
    }
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

describe('withPopulationCache', () => {
  it('runs the work with no cache, and returns its value, when no store is selected', async () => {
    const seen: (PopulationCache | undefined)[] = [];

    const result = await withPopulationCache({ root: repoRoot }, async (cache) => {
      seen.push(cache);
      return 'the work happened';
    });

    // `undefined` is passed explicitly rather than the work being skipped: the
    // uncached path is the normal path, and a caller must not have to arrange
    // its own fallback for it.
    expect(seen).toEqual([undefined]);
    expect(result).toBe('the work happened');
  });

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
});
