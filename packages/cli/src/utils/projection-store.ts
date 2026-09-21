/**
 * Selecting, opening and keying the **projection store** — the cross-process
 * cache that makes a second population of an unchanged tree cheap.
 *
 * ## Why the CLI owns this and `resources` does not
 *
 * `@vibe-agent-toolkit/resources` states the {@link ProjectionStore} contract
 * and never picks a backend, for the same reason it states the parse contract
 * and never picks a parser: it is the toolkit's most widely installed package,
 * and a storage engine is a *choice*. The choice is made here, at the edge that
 * already owns every other optional backend — see `optional-backend.ts`, whose
 * header names a projection store as one of the shapes it exists for.
 *
 * So `populate()` takes a {@link PopulationCache} it is handed, and this module
 * is the only place in the toolkit that knows `@vibe-agent-toolkit/projection-
 * sqlite` exists.
 *
 * ## The key, and why it is a whole-repository tree hash
 *
 * A stored extent is filed under `(rootId, treeHash)`. `populate()` derives the
 * root id itself so a caller cannot file one root's contents under another's;
 * this module supplies the other half.
 *
 * {@link gitTreeSnapshot} answers it with `git write-tree` against a throwaway
 * index, which covers staged edits, unstaged edits and untracked files, and
 * carries **no timestamp** — byte-identical content always produces the same
 * hash. 🪤 Never `git stash create`: a stash is a *commit*, so two calls over
 * identical content agree only within the same wall-clock second, and every
 * read would miss.
 *
 * ⚠️ That hash covers the whole **repository**, not the subtree the root names.
 * An edit anywhere in the repository therefore cools the cache for every root
 * inside it. This is conservative in the safe direction and cheap to be
 * conservative about — `git write-tree` against a throwaway index is the same
 * call `vibe-validate` makes on every commit.
 *
 * ## An opted-in cache that quietly does nothing is worse than no cache
 *
 * Every failure here is loud, and that is deliberate rather than harsh. A
 * selector nobody honours produces a measurement arm that believes it is
 * testing a cache and is testing an ordinary cold run — the "subject that
 * exercises nothing looks like a clean result" failure that has already cost
 * this project one whole A/B. So an uninstalled backend exits with the seam's
 * standard legible error, and a tree that cannot be keyed says so on stderr
 * rather than silently declining.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type * as ProjectionSqlite from '@vibe-agent-toolkit/projection-sqlite';
import type { PopulationCache, ProjectionStore } from '@vibe-agent-toolkit/resources';
import { parseEnvBoolean } from '@vibe-agent-toolkit/utils';
import { freshGitTreeSnapshot, gitTreeSnapshot, withGitSnapshotCache } from '@vibe-agent-toolkit/utils/git';

import { isModuleMissing, reportMissingBackend, type OptionalBackend } from './optional-backend.js';
import { installSqliteWarningFilter } from './sqlite-experimental-warning.js';

/**
 * The env var that selects — or now, DESELECTS — a projection store for this
 * process.
 *
 * 🔑 **The store is on by default, so this is the escape hatch rather than the
 * selector.** Same shape and same reason as `VAT_RESOURCES_CRAWL`: any value the
 * off-parser does not read as false leaves the store selected, including the
 * historical `sqlite`, so every script and lab arm that names it explicitly
 * keeps working and keeps MEANING the same thing. See
 * {@link PROJECTION_STORE_OFF} for the one way out.
 *
 * An environment switch rather than a config field, for the same reason
 * `VAT_INVENTORY_CRAWL` and `VAT_RESOURCES_CRAWL` are: it selects which
 * INSTRUMENT runs, not what the project means, and it has to be reachable from
 * the lab, which spawns the binary and controls its environment. A config field
 * would put the A and B arms inside the subject's own tree, where a measurement
 * edits the thing it measures.
 *
 * 🔑 It is read from the environment, and **every phase now runs in the process
 * that read it**, so `vat validate`'s phases cannot fail to see the selection
 * their orchestrator did. Which lanes share a store within one verb and across
 * invocations, with the measurements, and the ⚠️ one packaging enumeration still
 * on the walk: `docs/architecture/resource-scanning-and-caching.md` §3.7.
 */
export const PROJECTION_STORE_ENV = 'VAT_PROJECTION_STORE';

/**
 * {@link PROJECTION_STORE_ENV}'s value that names the SQLite backend. Redundant
 * with the default now, and kept — see
 * `docs/architecture/resource-scanning-and-caching.md` §3.7.
 */
export const PROJECTION_STORE_SQLITE = 'sqlite';

/**
 * The value that turns the store OFF while leaving VAT's other caches on.
 *
 * Read through the same {@link parseEnvBoolean} as every other VAT switch, so
 * `0`, `false`, `no` and `n` work too. The empty string joins them: unlike
 * {@link PROJECTION_STORE_DIR_ENV}, where empty falls back to a default
 * directory that means something, there is nothing else for a cleared selector
 * to mean.
 */
export const PROJECTION_STORE_OFF = 'off';

/**
 * Where the projection store's database lives, overriding the default.
 *
 * The default is `tmpdir/.vat-cache/<version>/projection-<shapeDigest>` — one
 * database per VAT release, shared by every root on the machine. This names a
 * different one **explicitly**, which is what an adopter with a per-job cache
 * directory, a shared build agent running two jobs at once, or a test arm that
 * must not touch the developer's live cache actually needs.
 *
 * 🪤 **What it replaces is redirecting `TMPDIR`, which works and is the wrong
 * instrument.** `defaultStoreDirectory()` resolves through
 * `vatCacheNamespaceRoot()` → `normalizedTmpdir()`, so pointing the OS temp
 * directory elsewhere does move the store — along with every other temp
 * consumer in the process, on a variable whose name is not the same on both
 * platforms (`TMPDIR` on POSIX; `TEMP`, then `TMP`, on Windows, so setting one
 * is silently inert on the other). It relocates the store as a side effect of
 * relocating something larger. This variable says the one thing meant.
 *
 * ⚠️ It does **not** consult `XDG_CACHE_HOME` or `HOME`. A caller that set
 * those believed it had its own database and was writing into the shared one;
 * the fix is to name the directory here, not to add more implicit roots.
 *
 * An environment variable rather than a config field, for the same reason
 * {@link PROJECTION_STORE_ENV} is one: it says where an INSTRUMENT keeps its
 * scratch space, not what the project means, and it has to be reachable from a
 * harness that spawns the binary.
 */
export const PROJECTION_STORE_DIR_ENV = 'VAT_PROJECTION_STORE_DIR';

/**
 * The env var that turns VAT's disk caches off for a run.
 *
 * Not this module's invention — `ParseCache` has read it since the parse cache
 * shipped, and `vat`'s root `--no-cache` exports it from a `preAction` hook so
 * the decision reaches every spawned phase. Named here rather than spelled
 * inline so the projection store is visibly the same tenant as the caches the
 * flag was written for.
 */
export const CACHE_ENV = 'VAT_CACHE';


/**
 * The backend as a user is told to install it.
 *
 * Named separately from the RAG backend's entry because the *reason* it ships
 * apart is different, and the install message is the only place a user learns
 * it: RAG carries a platform-native binary, while this one carries a Node
 * version floor.
 */
/** What Node throws for `import('node:sqlite')` when it is absent or still flagged. */
const UNKNOWN_BUILTIN_MODULE = 'ERR_UNKNOWN_BUILTIN_MODULE';

const PROJECTION_STORE_BACKEND: OptionalBackend = {
  feature: 'The projection store',
  packageName: '@vibe-agent-toolkit/projection-sqlite',
};

/**
 * Whether this process should read and write a projection store.
 *
 * **On unless turned off.** It used to be the opposite; the measurement that
 * paid for the flip, and the blob-tier bound that had to land first, are in
 * `docs/architecture/resource-scanning-and-caching.md` §3.7.
 *
 * Read from the environment at each call rather than memoized at module load:
 * `vitest.setup.js` deletes every `VAT_*` variable before any test module
 * loads, so a module-level binding would make the switch unobservable to every
 * test that sets it.
 *
 * ## The two switches are AND-ed, and the second one is a veto
 *
 * {@link PROJECTION_STORE_ENV} turns off THIS cache; {@link CACHE_ENV} says
 * whether this run caches at all. A store selected while `VAT_CACHE=0` was
 * measured writing a 9.8 MB, 18,079-row store on this repository and hitting it
 * on the next run — a user who asked for no cache silently got one, and
 * `vat cache`'s own help text described three caches while a fourth was being
 * written beside them.
 *
 * 🪤 Read through `parseEnvBoolean`, never for truthiness — `VAT_CACHE=1` is
 * the value an operator writes to turn caching ON, and a truthiness test would
 * read it as a reason to decline. It was previously a comparison against the
 * literal `'0'`, which is the same shape `ParseCache` carried and the same
 * defect: `VAT_CACHE=false` disabled nothing. The two now share one parser
 * (`@vibe-agent-toolkit/utils`) so the variable cannot be read two ways again.
 *
 * Only an explicit `false` vetoes. `parseEnvBoolean` returns `undefined` for a
 * value it cannot read, and an unreadable value is not something the operator
 * said — the veto has to be a statement, not a shrug. That reading is why both
 * variables can be read through ONE parser even though they now sit on
 * opposite default sides: each asks only whether the operator SAID no.
 *
 * @returns `true` when a store is selected
 */
export function projectionStoreSelected(): boolean {
  if (parseEnvBoolean(process.env[CACHE_ENV]) === false) return false;
  const selector = process.env[PROJECTION_STORE_ENV];
  // Unset is the default and the default is on.
  if (selector === undefined) return true;
  // `VAT_PROJECTION_STORE=` — see PROJECTION_STORE_OFF on why empty is off here
  // and unset-equivalent in the directory variable.
  if (selector.trim() === '') return false;
  return parseEnvBoolean(selector) !== false;
}

/**
 * An open store, the key half it is used with, and the way to let it go.
 *
 * ⚠️ **Deliberately NOT typed for SQL, and do not re-widen it.** This handle
 * reaches the database at {@link PROJECTION_STORE_DIR_ENV}'s directory, which
 * defaults to one file per VAT release shared by every root on the machine —
 * holding other repositories' link text, heading text and frontmatter. A field
 * typed `SqlQueryableStore` used to live here "for a caller that needs to ASK
 * the store something", and that caller was removed precisely because arbitrary
 * SQL over this store answers from trees the asker never named. `populate()`
 * needs the engine-free {@link PopulationCache} and nothing more; a query lane
 * builds its own store (see `projection-query.ts`).
 */
export interface OpenedPopulationCache {
  /** Hand this to `populate()`. */
  readonly cache: PopulationCache;
  /**
   * Close the underlying connection.
   *
   * Must be called. A `DatabaseSync` left open holds its file handle and, in
   * WAL mode, its read transaction — see `projection-sqlite`'s note on why an
   * unfinalized read statement pins a connection to a stale snapshot.
   */
  close(): Promise<void>;
}

/**
 * Open the projection store this process selected, keyed to one tree.
 *
 * Returns `undefined` when no store is selected, and when the tree cannot be
 * keyed — the two "carry on without a cache" answers. It does **not** return
 * `undefined` for an uninstalled backend: the store is on unless a user turned it
 * off, and answering that by silently not having one is how a default-on cache
 * becomes an unmeasured one.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root. Used to find the repository;
 *   the resulting hash covers that whole repository, not this subtree
 * @returns The cache and its closer, or `undefined` to populate uncached
 */
export async function openPopulationCache(options: {
  root: string;
}): Promise<OpenedPopulationCache | undefined> {
  if (!projectionStoreSelected()) return undefined;

  // Before the import, so a corpus outside a repository costs nothing and says
  // why. `gitTreeSnapshot` returns null for every "git could not answer" case —
  // no `git` on PATH, not a repository, a bare or unreadable one — and an empty
  // snapshot of an initialized repository stays distinguishable from it.
  const snapshot = gitTreeSnapshot({ cwd: options.root });
  if (snapshot === null) {
    // Not "the selector is set": the store is on by default, so most users who
    // see this never wrote the variable.
    process.stderr.write(
      `The projection store is on, but ${options.root} is not inside a readable git`
      + ' repository, so there is no deterministic key to store a projection under.'
      + ` Populating without a cache. Set ${PROJECTION_STORE_ENV}=${PROJECTION_STORE_OFF} to silence this.\n`,
    );
    return undefined;
  }

  const store = await loadStore();
  const cwd = options.root;
  return {
    cache: {
      store,
      treeHash: snapshot.hash,
      treeUnchanged: () => freshGitTreeSnapshot({ cwd })?.hash === snapshot.hash,
    },
    close: () => store.close(),
  };
}

/**
 * Load the selected backend, or report it as uninstalled and exit.
 *
 * 🪤 Only `ERR_MODULE_NOT_FOUND` means "not installed". A Node older than
 * 22.13.0 has no `node:sqlite` at all and fails with a *different* code, which
 * must propagate as itself: "install this package" would be the wrong repair
 * for "upgrade Node", and diagnosing a version floor as a missing dependency
 * sends a user round a loop that cannot terminate.
 *
 * @returns The opened store, typed as the engine-free contract — the SQLite
 *   backend really does return a `SqlQueryableStore`, and this narrows it away
 *   on purpose so the population path cannot grow a query
 */
async function loadStore(): Promise<ProjectionStore> {
  const directory = process.env[PROJECTION_STORE_DIR_ENV];
  // Spread rather than passed, because the backend defaults the field when it is
  // ABSENT and an explicit `undefined` is a different argument under
  // `exactOptionalPropertyTypes`. Empty string is treated as unset: an unset
  // variable and one exported as `''` are the same intent, and `''` would
  // otherwise resolve to the process cwd.
  return (await loadBackend()).openSqliteProjectionStore(
    directory === undefined || directory === '' ? {} : { directory },
  );
}

/**
 * Open a store that lives only in this process's memory.
 *
 * 🔑 **This is what keeps the query surface an ANSWER rather than a privilege.**
 * A caller with no store selected — CI's first run, or a developer who never set
 * the selector — still gets the same SQL over the same schema; the on-disk store
 * only makes the second run cheap. Without it, "what does this tree contain"
 * would be answerable only where a cache happened to exist, and two callers
 * would hold differently-shaped views of one tree.
 *
 * It is a cache that cannot hit: nothing survives the close, so a caller must
 * write the projection into it before asking anything.
 *
 * @returns An open, empty store; close it when done
 */
export async function openEphemeralQueryStore(): Promise<ProjectionSqlite.SqlQueryableStore> {
  return (await loadBackend()).openEphemeralProjectionStore();
}

/**
 * Open a compile-only probe over the full queryable schema, derived relations
 * included — for checking statements BEFORE any population or lens has run.
 *
 * ⚠️ Not {@link openEphemeralQueryStore}: that store has no table for a derived
 * relation until a lens fills it, which is how an unevaluated one is refused.
 *
 * @returns An open probe; close it when done
 */
export async function openCompileProbe(): Promise<ProjectionSqlite.ProjectionCompileProbe> {
  return (await loadBackend()).openProjectionCompileProbe();
}

/**
 * Load the selected backend module, or report it as uninstalled and exit.
 *
 * @returns The backend's module namespace
 */
async function loadBackend(): Promise<typeof ProjectionSqlite> {
  // `node:sqlite` emits one ExperimentalWarning as it loads, even on a Node that
  // needs no flag for it. `projection-sqlite` refuses to suppress that itself —
  // correctly, since a blanket NODE_NO_WARNINGS hides real warnings — and
  // assigns the filter to whichever caller turns the backend on by default.
  // That caller is this module, and this import is the boundary.
  //
  // Restored immediately afterwards: the warning fires at module evaluation, so
  // holding the filter open any longer would start hiding warnings this import
  // did not cause.
  const restoreWarnings = installSqliteWarningFilter();
  try {
    return await import('@vibe-agent-toolkit/projection-sqlite');
  } catch (error) {
    const floor = nodeSqliteFloorFailure(error);
    if (floor !== undefined) throw floor;
    if (!isModuleMissing(error)) throw error;
    reportMissingBackend(PROJECTION_STORE_BACKEND);
  } finally {
    restoreWarnings();
  }
}

/**
 * The legible failure for "your Node is too old", or `undefined` when this is
 * some other failure — including "the package is absent".
 *
 * Exported, and returning the error rather than throwing it, so the DIAGNOSIS
 * is unit-testable without a mocked dynamic import. A test cannot make a mocked
 * `import()` reject with a plain `{ code }` — the test runner wraps whatever a
 * module factory throws in its own error, so the code never survives to be
 * read — and the branch's whole value is the message it produces.
 *
 * 🪤 The two are **different error codes**, and only one of them reaches
 * {@link isModuleMissing}. `@vibe-agent-toolkit/projection-sqlite` imports
 * `node:sqlite`, which loads unflagged from Node 22.13.0 (it was added in 22.5.0
 * behind `--experimental-sqlite`); on 22.0–22.12 an ordinary import fails
 * with `ERR_UNKNOWN_BUILTIN_MODULE`, not `ERR_MODULE_NOT_FOUND`. Without this
 * branch the user gets a bare `No such built-in module: node:sqlite` — which
 * names neither the version floor nor the fix.
 *
 * ⚠️ It is reachable on an ordinary run and is not a corner: the query lane has
 * always fallen back to {@link openEphemeralQueryStore} when no store is
 * selected, which is the default, so `node:sqlite` is required on a default
 * `vat resources query` whichever way the lane resolves its store.
 *
 * 🪤 This used to say "EVERY `vat resources query`/`check` run", and that was
 * too strong for `check`. Measured against the built CLI on Node v24.13.1 by
 * counting the `ExperimentalWarning` `node:sqlite` emits at load — the only
 * externally visible tell that the module was reached at all:
 *
 * | Command | Warnings | Backend loaded? |
 * |---|---|---|
 * | `vat resources query "SELECT …"` | 1 | yes |
 * | `vat resources check`, no checks declared | 0 | **no** |
 *
 * `check` reaches a store only when the project declares checks for it to
 * evaluate, so a repo with none never loads the backend and never needed the
 * floor for that command. The floor argument is unaffected — `query` alone
 * establishes it — but "every default run of those two commands" was a claim
 * nothing had counted.
 *
 * ✅ **VAT's declared floor is now `>=22.13.0`, so this no longer fires on a
 * SUPPORTED Node.** It used to: the manifests said `>=22.0.0` while these two
 * commands could not run below 22.13.0, which meant thirteen Node patch
 * releases were advertised as supported and hard-failed here. The floor was
 * raised to stop advertising what VAT cannot do. The branch stays load-bearing
 * for the Node that is merely *installed* rather than supported — `engines` is
 * a warning in npm and nothing at all under most runners, so a user on 22.4
 * still reaches this and still deserves to be told which number is wrong.
 *
 * The repair stays distinct from the missing-package one on purpose:
 * "install this package" is the wrong instruction for "upgrade Node", and
 * sending someone round that loop cannot terminate.
 *
 * @param error - Whatever the dynamic import threw
 * @returns The error to raise when Node itself lacks the builtin; `undefined`
 *   when this failure is something else and the caller should keep diagnosing
 */
export function nodeSqliteFloorFailure(error: unknown): Error | undefined {
  const isFloor =
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === UNKNOWN_BUILTIN_MODULE;
  if (!isFloor) return undefined;
  return new Error(
    'The projection store needs `node:sqlite`, which this Node does not have.'
    // States the NODE fact (when the module arrived), never VAT's floor. The
    // floor lives in `engines.node` and `vat doctor` derives it from there
    // precisely so it has one home; restating it in a string would be the
    // second copy that change exists to remove, and it would go stale silently
    // the next time the floor moves.
    + ` \`node:sqlite\` loads unflagged from Node 22.13.0 (added in 22.5.0 behind`
    + ` \`--experimental-sqlite\`) — you are on ${process.version}.`
    + ' Upgrade Node to 22.13.0 or newer. Installing a package will not help:'
    + ' the module is built into Node, not published to npm.',
  );
}

/**
 * The population scope this async context is already inside, if any.
 *
 * `AsyncLocalStorage` and not a module-level variable, for the reason
 * `withGitSnapshotCache` uses one: a scope has to end when its own frame ends
 * and not when some other frame happens to finish, and a plain binding would
 * leak the outer scope into anything that ran after it in the same tick.
 */
const populationScope = new AsyncLocalStorage<ActivePopulationScope>();

/**
 * What an open scope publishes to the scopes nested inside it.
 *
 * 🪤 A WRAPPER around the opened cache rather than the cache itself: a scope
 * that opened nothing is still a scope, and storing its `undefined` bare would
 * make `getStore()` answer `undefined` for both "no scope above me" and "a scope
 * above me with no store" — two states that take opposite actions.
 */
interface ActivePopulationScope {
  /** What the enclosing scope opened, or `undefined` if it opened nothing. */
  readonly opened: OpenedPopulationCache | undefined;
}

/**
 * The already-open cache this scope may join, or `undefined` to open its own.
 *
 * Wrapped in a one-field object rather than returned bare, because `undefined`
 * is a legitimate thing to JOIN — a run with the store off — and a bare return
 * could not tell that from "open your own".
 *
 * @param active - The scope already open in this async context
 * @param root - The corpus root the nested caller named
 * @returns The cache to reuse (possibly `undefined`), or `undefined` to open
 */
function joinableCache(
  active: OpenedPopulationCache | undefined,
  root: string,
): { readonly cache: PopulationCache | undefined } | undefined {
  // No store in this process, so there is nothing to key and every scope's
  // answer is the same `undefined`. Also keeps uncached nesting free: no
  // snapshot, no `gitFindRoot`.
  if (!projectionStoreSelected()) return { cache: undefined };
  // Selected, but the enclosing scope could not key its own root — outside a
  // readable repository. That says nothing about THIS root, so ask again.
  if (active === undefined) return undefined;
  // Memoized by the enclosing `withGitSnapshotCache` bracket, so a map lookup
  // for a repository it has visited and a real snapshot only for one it has not.
  const snapshot = gitTreeSnapshot({ cwd: root });
  // 🔑 The tree hash, never "a scope is open". An extent is filed under
  // `(rootId, treeHash)`, so a lane in another repository handed this one's hash
  // would file its extent under a key that does not describe it — silently. Two
  // roots inside ONE repository do share a hash: the key covers the repository.
  return snapshot !== null && snapshot.hash === active.cache.treeHash ? { cache: active.cache } : undefined;
}

/**
 * Open a store for this scope, run the work inside it, and close it.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the cache, or `undefined` when there is none to give
 * @returns Whatever `work` returned
 */
async function runOwnedScope<T>(
  options: { root: string },
  work: (cache: PopulationCache | undefined) => Promise<T>,
): Promise<T> {
  const opened = await openPopulationCache(options);
  try {
    // Registered even when nothing was opened, so a nested scope can tell "no
    // store in this process" from "no scope above me" — and so the nested scope
    // stays inside THIS scope's git-snapshot memo either way.
    return await populationScope.run({ opened }, () => work(opened?.cache));
  } finally {
    await opened?.close();
  }
}

/**
 * Run one command's work with a projection store open for its whole duration,
 * and closed however it ends.
 *
 * A scope rather than a bare open/close pair, because the store must outlive the
 * call that builds a population source and not merely the call that uses it: the
 * inventory extractor MEMOIZES its population provider and may reach it well
 * after the frame that supplied it has returned. A store closed at the end of
 * that frame would be closed under its own consumer.
 *
 * It is also the `withGitSnapshotCache` bracket for the work inside it, so the
 * key and the extent filed under it come from ONE git snapshot — see the note
 * in the body.
 *
 * `undefined` on a run with no store selected, which is the shape every
 * population lane wants: no store means re-derive, not fail.
 *
 * ⚠️ A caller that wants to run SQL must NOT query this store. It is one
 * database per VAT release, shared by every root on the machine, so arbitrary
 * SQL over it answers from other repositories — see `projection-query.ts`.
 * That is also why this is the ONLY scope over the opened store: there is no
 * separate "opened handle" bracket for a caller wanting more than the cache,
 * because there is nothing legitimate for such a caller to want.
 *
 * ## 🔑 It NESTS, and the outermost scope wins
 *
 * A scope opened inside another over the same repository **joins** it: same
 * cache by identity, no second database, no second `git write-tree`, and the
 * inner scope does not close what it did not open. That lets an orchestrator
 * hold one bracket over a whole run (`vat validate` does) while each lane
 * underneath keeps its own and stays correct run alone. Reuse is gated on the
 * TREE HASH, never on "a scope is open" — see {@link joinableCache}.
 *
 * ⚠️ The whole nest shares ONE snapshot, so work that must see its own edits as
 * they land must not run inside a single scope. That is why a hoist is a
 * decision rather than a refactor.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the cache, or `undefined` when there is none to give
 * @returns Whatever `work` returned
 */
export async function withPopulationCache<T>(
  options: { root: string },
  work: (cache: PopulationCache | undefined) => Promise<T>,
): Promise<T> {
  const active = populationScope.getStore();
  if (active !== undefined) {
    const joinable = joinableCache(active.opened, options.root);
    // 🪤 No new git bracket on either path: an inner scope stays inside the
    // outer one's memo, which is where the deduplication lives. A fresh bracket
    // here would start an empty memo and re-snapshot the same repository — a
    // dedupe that does nothing while looking exactly like one that works.
    return joinable === undefined ? runOwnedScope(options, work) : work(joinable.cache);
  }
  // ONE git snapshot for the whole scope, and this is the level that gets it:
  // `openPopulationCache` below takes one to derive the store key, and the crawl
  // that runs inside `work` takes another to enumerate the extent — same
  // repository, sequentially, ~195 ms and ~159 ms measured on a large monorepo.
  //
  // The correctness half matters more than the saving. Taken separately, a
  // working-tree edit landing between them makes the two snapshots DIFFERENT
  // answers, and the extent from the second is then filed under the key from the
  // first: a cache entry whose key does not describe its contents, written
  // silently. The bracket closes that race rather than merely deduplicating.
  //
  // Opened here rather than around either consumer because it must enclose BOTH
  // — a bracket opened deeper than one of them dedupes nothing while looking
  // exactly like a bracket that works. Every CLI entry into the projection lane
  // (`inventory`, `resource-loader`'s two) reaches the store through this scope,
  // and `vat validate`'s orchestrator holds one OUTSIDE all of them, which the
  // nesting above is what makes safe.
  return withGitSnapshotCache(() => runOwnedScope(options, work));
}
