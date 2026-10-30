/**
 * `projection-store` — selecting a backend, declining a tree, and scoping the
 * store's lifetime when no tree is keyed.
 *
 * This module is the ONLY place in the toolkit that knows the SQLite backend
 * exists, so what is under test here is the *wiring*, not the storage engine:
 * which env value turns the cache on, what happens when the key cannot be
 * derived, and which paths return before a key is ever derived. The backend
 * itself is mocked (`../projection-store-test-doubles.js`) — a unit test that
 * opened a real `node:sqlite` database would be testing `projection-sqlite`,
 * which has its own suites, and would couple this file to whether the
 * workspace link happens to be installed.
 *
 * Every case that KEYS a real git tree — the hash, its determinism, the store
 * directory, the scope's close and reentrancy, the snapshot bracket — lives in
 * `test/integration/projection-store-git.integration.test.ts`: each spawns
 * `git write-tree` over a fixture repository, which is integration-tier cost.
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
 * 3. **A store that is turned off costs nothing.** No `git write-tree`, no
 *    backend constructed — asserted through the counter below.
 */

import type { PopulationCache } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
// Type-only, purely so the mock factory can spread the real module without an
// inline `typeof import()` annotation, which this repo's lint forbids.
import type * as UtilsGitModule from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { backend, captureStderr, isolateProjectionStoreTests } from '../projection-store-test-doubles.js';
import { createTempDirTracker } from '../system/test-common.js';

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
vi.mock('@vibe-agent-toolkit/projection-sqlite', async () =>
  (await import('../projection-store-test-doubles.js')).backend.moduleExports());

/**
 * `gitTreeSnapshot` is left REAL and merely counted.
 *
 * The counter exists for one assertion: that a process with no store selected
 * returns before the key is even derived, which is upstream of the dynamic
 * import and is therefore the cheapest observable proof the lazy seam is
 * intact.
 */
const git = vi.hoisted(() => ({ calls: { count: 0 } }));
vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsGitModule>();
  return {
    ...actual,
    gitTreeSnapshot: (options: { cwd: string }) => {
      git.calls.count += 1;
      return actual.gitTreeSnapshot(options);
    },
  };
});

const {
  CACHE_ENV,
  nodeSqliteFloorFailure,
  openPopulationCache,
  PROJECTION_STORE_DIR_ENV,
  PROJECTION_STORE_ENV,
  PROJECTION_STORE_OFF,
  PROJECTION_STORE_SQLITE,
  projectionStoreSelected,
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
const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-projection-store-');

/**
 * Roots for the store-OFF paths. Plain directories, NOT repositories: every
 * test that uses them asserts `git.calls.count` is zero, so the root is never
 * handed to git — and if the off check broke, that count is what goes red.
 */
let repoRoot: string;
let secondRepoRoot: string;
let outsideAnyRepo: string;

beforeAll(() => {
  const scratch = createTempDir();

  repoRoot = safePath.join(scratch, 'repo');
  mkdirSyncReal(repoRoot, { recursive: true });
  secondRepoRoot = safePath.join(scratch, 'other-repo');
  mkdirSyncReal(secondRepoRoot, { recursive: true });

  // A plain directory with no repository above it. git resolves upward, so it
  // must sit under the realpathed OS tmpdir, never inside this checkout, or
  // this arm would assert the opposite of what it claims while still going
  // green.
  outsideAnyRepo = safePath.join(scratch, 'not-a-repo');
  mkdirSyncReal(outsideAnyRepo, { recursive: true });
});

afterAll(() => {
  cleanupTempDirs();
});

isolateProjectionStoreTests({
  envNames: [PROJECTION_STORE_ENV, CACHE_ENV, PROJECTION_STORE_DIR_ENV],
  resetUnscopedNoticeLedger,
});

beforeEach(() => {
  git.calls.count = 0;
});

describe('projectionStoreSelected', () => {
  it('is true when the selector is not set at all', () => {
    // The default, and the one that matters most — and it MOVED. It used to be
    // false, on the rule that a cache's win is a claim about cost and a default
    // flipped before the cost is measured is a claim nobody checked. The
    // measurement is in the function's own docstring: 3.5× warm on a
    // 12,602-file adopter tree, 2.4× on VAT itself, with the cold arm never
    // slower than the uncached one.
    expect(process.env[PROJECTION_STORE_ENV]).toBeUndefined();
    expect(projectionStoreSelected()).toBe(true);
  });

  it.each([
    ['the backend by name, as every pre-flip script spells it', PROJECTION_STORE_SQLITE],
    ['a case variant of it', 'SQLite'],
    ['the right word with stray whitespace', ' sqlite '],
    ['a truthy-looking value', '1'],
    ['a backend that does not exist', 'duckdb'],
  ])('stays selected for %s', (_description, value) => {
    // ⚠️ `duckdb` is in this list deliberately, and it is the uncomfortable one:
    // an unrecognised backend name leaves the SQLite store selected rather than
    // refusing. There is exactly one backend, so a refusal would have no
    // alternative to offer; the day a second exists this becomes a real
    // enumeration and that is the day to add the refusal.
    process.env[PROJECTION_STORE_ENV] = value;

    expect(projectionStoreSelected()).toBe(true);
  });

  it.each([
    ['the documented escape hatch', PROJECTION_STORE_OFF],
    ['an operator shouting it', 'OFF'],
    ['an operator clearing the variable', ''],
    ['a value that arrived through a YAML block as whitespace', '  '],
    ['the numeric off spelling', '0'],
    ['an operator spelling it out', 'false'],
    ['an operator saying no', 'no'],
  ])('is false for %s', (_description, value) => {
    // The opt-out an adopter needs, read through the same `parseEnvBoolean`
    // every other VAT switch is read through — so there is one off-vocabulary
    // in the toolkit rather than a private one here. The empty string is the
    // one addition: an operator who cleared the variable said something, and
    // unlike VAT_PROJECTION_STORE_DIR there is no default value for an empty
    // selector to fall back to.
    process.env[PROJECTION_STORE_ENV] = value;

    expect(projectionStoreSelected()).toBe(false);
  });

  it.each([
    ['the root --no-cache flag, which exports this', '0'],
    ['an operator spelling it out', 'false'],
    ['an operator shouting it', 'FALSE'],
    ['an operator saying no', 'no'],
    ['an operator flipping it off', 'off'],
    ['a value that arrived through a YAML block with whitespace', ' 0 '],
  ])('is false when %s turns the disk caches off', (_description, value) => {
    // The projection store IS one of VAT's disk caches, and `--no-cache` is
    // documented as "every cache off". Honouring the backend selector while
    // ignoring the switch that disables caching gave a user who asked for no
    // cache a 9.8 MB one anyway — measured on this repository, where a
    // `--no-cache` run still wrote 18,079 rows and the run after it still hit
    // the store.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    process.env[CACHE_ENV] = value;

    expect(projectionStoreSelected()).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'maybe', '', '2'])(
    'stays selected for VAT_CACHE=%j, which is not the off switch',
    (value) => {
      // A truthiness test here would read `VAT_CACHE=1` — the value an operator
      // writes to turn caching ON — as a reason to decline the store. The
      // unparsable values are in this list on purpose: `parseEnvBoolean`
      // returns `undefined` for them and THIS caller reads that as "not a
      // veto", because the veto has to be something the operator actually said.
      process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
      process.env[CACHE_ENV] = value;

      expect(projectionStoreSelected()).toBe(true);
    },
  );

  it('reads the environment on every call rather than memoizing it at module load', () => {
    // 🪤 THE load-bearing test in this file. `vitest.setup.js` deletes every
    // `VAT_*` variable before any test module is loaded, so a module-level
    // binding would be captured once and could never move again. Every other
    // test here that sets the selector would then pass while silently
    // exercising the wrong path, and the whole suite would be a clean result
    // over a subject that does nothing. Watching the answer move under a live
    // process is the only way to see that; a single call, however it is
    // arranged, cannot.
    expect(projectionStoreSelected()).toBe(true);

    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_OFF;
    expect(projectionStoreSelected()).toBe(false);

    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    expect(projectionStoreSelected()).toBe(true);

    process.env[PROJECTION_STORE_ENV] = '';
    expect(projectionStoreSelected()).toBe(false);
  });
});

describe('openPopulationCache', () => {
  it('returns undefined without keying the tree or opening a backend when the store is turned off', async () => {
    // Explicitly off, because the default is now ON: a version of this test that
    // relied on the unset default would have started asserting the opposite of
    // what it claims the moment the flip landed, and would still have gone green
    // — the store opens, the snapshot is taken, and `opened` is defined.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_OFF;

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
});

/**
 * The `node:sqlite` version floor, tested at the DIAGNOSIS rather than through
 * the dynamic import.
 *
 * 🪤 **A mocked `import()` cannot deliver this error.** Vitest replaces whatever
 * a module factory throws with its own `[vitest] There was an error when mocking
 * a module` error, so the `code` the branch reads never survives the seam —
 * measured, both with a throwing `vi.mock` factory (which `vi.resetModules()`
 * does not even re-run) and with `vi.doMock`. That is why the mapping is an
 * exported pure function: the alternative is a test that mocks the import,
 * exercises the OTHER branch, and looks like coverage.
 */
describe('nodeSqliteFloorFailure', () => {
  it('names the version floor and the fix when Node lacks the builtin', () => {
    // Node 22.0–22.12 throws `ERR_UNKNOWN_BUILTIN_MODULE` for
    // `import('node:sqlite')`. Bare, the user sees `No such built-in module:
    // node:sqlite`, which names neither the floor nor the repair.
    const failure = nodeSqliteFloorFailure(
      Object.assign(new Error('No such built-in module: node:sqlite'), {
        code: 'ERR_UNKNOWN_BUILTIN_MODULE',
      }),
    );

    expect(failure?.message).toContain('22.13.0');
    expect(failure?.message).toContain(process.version);
    // And it forecloses the wrong repair explicitly: "install this package"
    // sends someone round a loop that cannot terminate, because the module is
    // built into Node rather than published to npm.
    expect(failure?.message).toContain('built into Node');
  });

  it.each([
    ['the package really is absent', 'ERR_MODULE_NOT_FOUND'],
    ['the failure carries some other code', 'EACCES'],
  ])('declines to diagnose a floor when %s', (_description, code) => {
    // Returning `undefined` is what lets `loadBackend` fall through to the
    // install repair. Claiming the floor here would tell a user to upgrade Node
    // when the fix is to install a package — the same terminating-loop failure
    // in the other direction.
    expect(nodeSqliteFloorFailure(Object.assign(new Error('nope'), { code }))).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ERR_UNKNOWN_BUILTIN_MODULE'],
  ])('declines to diagnose %s, which carries no code at all', (_description, thrown) => {
    // `throw` accepts any value, and the string arm is the sharp one: it CONTAINS
    // the code, so a substring test on the thrown value would claim the floor.
    expect(nodeSqliteFloorFailure(thrown)).toBeUndefined();
  });
});

describe('withPopulationCache', () => {
  it('runs the work with no cache, and returns its value, when the store is turned off', async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_OFF;
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

  it('opens no backend at all when the disk caches are turned off', async () => {
    // Stronger than "returns undefined": the store must never be CONSTRUCTED,
    // because constructing it creates the database file and its schema. A
    // `--no-cache` run that still opened a connection would leave a store on
    // disk with the right namespace and an empty schema, which reads to anyone
    // measuring by file size as a populated cache — an empty and a populated
    // SQLite file are both 118,784 bytes at the sizes this store starts from.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    process.env[CACHE_ENV] = '0';
    const seen: (PopulationCache | undefined)[] = [];

    const result = await withPopulationCache({ root: repoRoot }, async (cache) => {
      seen.push(cache);
      return 'uncached';
    });

    expect(seen).toEqual([undefined]);
    expect(result).toBe('uncached');
    expect(backend.openCalls.count).toBe(0);
    // Upstream of the key, too: no `git write-tree` is spawned for a store this
    // process is not going to have.
    expect(git.calls.count).toBe(0);
  });

  it('gives a nested scope no cache when the store is turned off, without reopening the question', async () => {
    // The uncached path has to nest too, and has to stay cheap while it does:
    // the inner scope must not spawn its own `git write-tree` to discover there
    // is nothing to reuse.
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_OFF;
    const seen: (PopulationCache | undefined)[] = [];

    await withPopulationCache({ root: repoRoot }, async (outerCache) => {
      seen.push(outerCache);
      return withPopulationCache({ root: secondRepoRoot }, async (innerCache) => {
        seen.push(innerCache);
      });
    });

    expect(seen).toEqual([undefined, undefined]);
    expect(backend.openCalls.count).toBe(0);
    expect(git.calls.count).toBe(0);
  });
});

describe('the cannot-key notice — once per command run', () => {
  /**
   * 🚨 The "once" ledger was a module-level set, so a root noticed by one command was never noticed
   * again by ANY later command in the same process — a second `vat validate` in one test worker,
   * or a long-lived host, ran uncached in silence. "Once" belongs to the outermost population
   * scope: every nested scope joins it, and the next run starts fresh.
   */
  it('prints once across nested scopes, and again in the next command run', async () => {
    process.env[PROJECTION_STORE_ENV] = PROJECTION_STORE_SQLITE;
    const stderr = captureStderr();
    const oneRun = (): Promise<void> => withPopulationCache({ root: outsideAnyRepo }, () =>
      withPopulationCache({ root: outsideAnyRepo }, () => Promise.resolve()));
    try {
      await oneRun();
      await oneRun();
    } finally {
      stderr.restore();
    }

    expect(stderr.written.join('').split('not inside a readable git repository')).toHaveLength(3);
  });
});
