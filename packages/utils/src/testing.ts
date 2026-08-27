/**
 * Fixture primitives shared by suites in more than one package.
 *
 * Deliberately framework-free: nothing here imports `vitest`, so this module
 * stays a plain function library rather than something that registers hooks as a
 * side effect of being imported. Each suite owns its own `beforeEach`/
 * `afterEach` and calls these from inside them — two lines, which is below
 * anything worth sharing, while the part that is genuinely identical (mkdtemp,
 * write the literal, remove the tree) lives here once.
 *
 * It earned a home in `utils` the ordinary way: two packages needed it, not one
 * package speculating that a second might.
 *
 * ⛔ **Do not import `vitest` here to share the hook wrapper itself.**
 * `subpath-purity.test.ts` pins this entry at an EMPTY third-party set, and that
 * pin is load-bearing: `./testing` is a published subpath, so a test framework
 * reached from it becomes a runtime requirement for every adopter who imports
 * it. {@link replantableCorpus} exists precisely so the per-test wrapper each
 * suite still writes is three lines rather than twelve.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from './path-utils.js';

// The rest of the testing surface. ⚠️ This re-export is the ENTIRETY of what
// `./testing` used to be, and dropping it silently removed `detachGitEnv`,
// `setupSyncTempDirSuite` and every sibling from a published subpath. A module
// that is both a definition site and a barrel loses the barrel first.
export * from './test-helpers.js';

/** A planted fixture tree and the means to remove it. */
export interface TempCorpus {
  /** Absolute path to the tree's root. */
  root: string;
  /** Remove the tree. Safe to call when it is already gone. */
  cleanup: () => void;
}

/**
 * Write a literal corpus into a fresh temp directory.
 *
 * 🪤 Fixture files must NOT be byte-identical to each other when the suite is
 * about content-addressed behaviour: VAT's blobs are keyed on their bytes plus
 * the parser kind, so two files with the same content collapse into ONE blob and
 * assertions then describe whichever path sorted first. Give each fixture a
 * distinguishing marker line.
 *
 * ⚠️ The root is minted per call, so a suite that plants per test must call this
 * per test — a root captured once and reused across tests survives its own
 * `cleanup`.
 *
 * @param prefix - `mkdtemp` prefix, so a leaked directory names its own suite
 * @param corpus - Fixture name to file content; written verbatim as UTF-8.
 *   Names may include forward-slash subpaths only if their parents already exist
 * @returns The tree's root and its teardown
 */
export function createTempCorpus(
  prefix: string,
  corpus: Readonly<Record<string, string>>,
): TempCorpus {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  for (const [name, content] of Object.entries(corpus)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixture name from the caller's own literal corpus, under this call's fresh mkdtemp root
    writeFileSync(safePath.join(root, name), content, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A corpus that can be planted and cleared repeatedly — one tree per test. */
export interface ReplantableCorpus {
  /** Plant a fresh tree. Drive from the suite's `beforeEach`. */
  plant: () => void;
  /** Remove the current tree, if any. Drive from the suite's `afterEach`. */
  clear: () => void;
  /** The root minted by the most recent {@link plant}. */
  root: () => string;
}

/**
 * Hold a per-test corpus root, so a suite's hook wrapper is three lines.
 *
 * ⚠️ **The root comes back through a GETTER, never as a value.** A per-test
 * fixture is reminted for every test, so a root captured at registration time is
 * `undefined` in the first test and stale in every one after it. That mistake is
 * the reason this holder exists rather than each suite keeping its own `let`.
 *
 * ⭐ Framework-free on purpose: it takes no hooks and registers none, so the
 * suite still owns its own `beforeEach`/`afterEach` and this module keeps the
 * empty third-party set its purity pin asserts. See the module docstring.
 *
 * 🪤 `root()` before the first `plant()` THROWS by name. The shape it replaced
 * read an uninitialised `let` and raised `Cannot read properties of undefined`
 * from inside the fixture, which names neither the suite nor the missing hook.
 *
 * @param prefix - `mkdtemp` prefix, so a leaked directory names its own suite
 * @param corpus - Fixture name to file content, as {@link createTempCorpus} takes it
 * @returns Plant/clear/root, to be driven from the caller's own hooks
 */
export function replantableCorpus(
  prefix: string,
  corpus: Readonly<Record<string, string>>,
): ReplantableCorpus {
  let planted: TempCorpus | undefined;
  return {
    plant: () => {
      // 🪤 Removes any tree still standing FIRST. Nested `describe` blocks each
      // get their own `beforeEach` and vitest runs outer-then-inner before a
      // single `afterEach`, so a double plant is ordinary rather than exotic.
      // Overwriting the handle without this would leak the first tree for the
      // process's lifetime, silently and only on the suites that nest.
      planted?.cleanup();
      planted = createTempCorpus(prefix, corpus);
    },
    clear: () => {
      planted?.cleanup();
      planted = undefined;
    },
    root: () => {
      if (planted === undefined) {
        throw new Error(
          `replantableCorpus('${prefix}'): root() before plant() — the suite is missing its beforeEach`,
        );
      }
      return planted.root;
    },
  };
}
