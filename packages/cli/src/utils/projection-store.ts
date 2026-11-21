/**
 * Selecting, opening and keying the **projection store** — the cross-process
 * cache that makes a second population of an unchanged tree cheap.
 *
 * ## Why the CLI owns this and `resources` does not
 *
 * `@vibe-agent-toolkit/resources` states the {@link FactStore} contract
 * and never picks a backend, for the same reason it states the parse contract
 * and never picks a parser: it is the toolkit's most widely installed package,
 * and a storage engine is a *choice*. The choice is made here, at the edge that
 * already owns every other optional backend — see `optional-backend.ts`, whose
 * header names a projection store as one of the shapes it exists for.
 *
 * So `populate()` takes a {@link PopulationCache} it is handed, and this module
 * is the only place in the toolkit that knows `@vibe-agent-toolkit/projection-
 * sqlite` exists (`local/projection-sqlite-import-boundary`). It also opens the
 * run database a query runs on, which that package declares and no port does.
 *
 * ## The key, and why it is a whole-repository tree hash
 *
 * A stored extent is filed under `(rootId, treeHash)`. `populate()` derives the
 * root id itself so a caller cannot file one root's contents under another's;
 * this module supplies the other half.
 *
 * {@link gitTreeKey} answers it with `git write-tree` against a throwaway
 * index, which covers staged edits, unstaged edits and untracked files, and
 * carries **no timestamp** — byte-identical content always produces the same
 * hash. It declines a tree whose index flags any file assume-unchanged or
 * skip-worktree (a sparse checkout included): git does not read such a file, so
 * the hash would not describe its bytes, and the run populates without a store.
 * 🪤 Never `git stash create`: a stash is a *commit*, so two calls over
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
import { PROJECTION_TABLES, VAT_CACHE_DIR_ENV, type FactStore, type PopulationCache, type Projection, type ProjectionTableName, vatCacheRoot } from '@vibe-agent-toolkit/resources';
import { parseEnvBoolean, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { freshGitTreeKey, gitSnapshotFailureOf, gitTreeKey, type GitTreeSnapshot, withGitSnapshotCache } from '@vibe-agent-toolkit/utils/git';

import { noticeToOperator, withNoticeLedger } from './operator-notices.js';
import { isModuleMissing, missingBackendError, type OptionalBackend } from './optional-backend.js';
import type { HydrationPlan } from './projection-lenses.js';
import { installSqliteWarningFilter } from './sqlite-experimental-warning.js';

/**
 * The env var that selects — or now, DESELECTS — a projection store for this
 * process.
 *
 * 🔑 **The store is on by default, so this is the escape hatch rather than the
 * selector.** Any value the
 * off-parser does not read as false leaves the store selected, including the
 * historical `sqlite`, so every script and lab arm that names it explicitly
 * keeps working and keeps MEANING the same thing. See
 * {@link PROJECTION_STORE_OFF} for the one way out.
 *
 * An environment switch rather than a config field, for the same reason
 * `VAT_INVENTORY_CRAWL` and `VAT_EXTENT_SOURCE` are: it selects which
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
 * `VAT_CACHE_DIR`, where empty falls back to a default directory that means
 * something, there is nothing else for a cleared selector to mean.
 *
 * Where the store lives is not this module's question: it is
 * `<vatCacheRoot()>/<namespace>/projection-<shapeDigest>/`, and `VAT_CACHE_DIR`
 * moves the whole cache root — see `cache-root.ts` in `@vibe-agent-toolkit/resources`.
 */
export const PROJECTION_STORE_OFF = 'off';

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
 * **On unless turned off** (rationale: `docs/architecture/resource-scanning-and-caching.md` §3.7).
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
 * read it as a reason to decline. It shares one parser with `ParseCache`
 * (`@vibe-agent-toolkit/utils`) so the variable cannot be read two ways.
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
  // and unset-equivalent in `VAT_CACHE_DIR`.
  if (selector.trim() === '') return false;
  return parseEnvBoolean(selector) !== false;
}

/**
 * An open store, the key half it is used with, and the way to let it go.
 *
 * ⚠️ **Deliberately NOT typed for SQL, and do not re-widen it.** This handle
 * reaches the database under the cache root (`VAT_CACHE_DIR`), which is one
 * file per VAT release shared by every root that uses that cache root —
 * holding other repositories' link text, heading text and frontmatter, so
 * arbitrary SQL over it would answer from trees the asker never named.
 * `populate()` needs the engine-free {@link PopulationCache} and nothing more; a
 * query lane builds its own store (see `projection-query.ts`).
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
 * The snapshot that keys `root`'s store entry, or `null` — after telling the operator, once per
 * root per command run (the notice scope {@link withPopulationCache} enters), that the run
 * populates without a cache.
 *
 * `gitTreeKey` returns a failure for every "git could not answer" case — no `git` on PATH, not
 * a repository, a bare or unreadable one — and for an index that hides files from the snapshot
 * (assume-unchanged, skip-worktree); an empty snapshot of an initialized repository stays
 * distinguishable from it. The notice names the cause the one classifier (`gitSnapshotFailureOf`) decides.
 *
 * 🪤 Once per root: `vat validate`'s orchestrator scope and each lane's own scope inside it both ask
 * when the outer one could not key ({@link joinableCache} "asks again" for a root it cannot vouch
 * for), and the answer — and the notice — is the same every time.
 *
 * @param root - The absolute corpus root
 * @returns The snapshot, or `null` when the tree cannot be keyed
 */
function storeKeyOrNotice(root: string): GitTreeSnapshot | null {
  const snapshot = gitTreeKey({ cwd: root });
  if (snapshot.ok) return snapshot;
  // Not "the selector is set": the store is on by default, so most users who
  // see this never wrote the variable.
  noticeToOperator(
    'store',
    'The projection store is on, but git cannot key this tree, so there is no deterministic key to store a'
    + ` projection under: ${gitSnapshotFailureOf(snapshot).reason}`
    + ` Populating without a cache. Set ${PROJECTION_STORE_ENV}=${PROJECTION_STORE_OFF} to silence this.`,
    root,
  );
  return null;
}

/**
 * Open the projection store this process selected, keyed to one tree.
 *
 * Returns `undefined` when no store is selected, when the tree cannot be
 * keyed, and when a damaged store file could not be replaced (see
 * {@link loadStore}) — the "carry on without a cache" answers, each but the
 * first told to the operator. It does **not** return
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
  // why.
  const snapshot = storeKeyOrNotice(options.root);
  if (snapshot === null) return undefined;

  noticeCacheRootInsideTree(options.root);
  const store = await loadStore();
  if (store === undefined) return undefined;
  const cwd = options.root;
  return {
    cache: {
      store,
      treeHash: snapshot.hash,
      treeUnchanged: () => {
        const fresh = freshGitTreeKey({ cwd });
        return fresh.ok && fresh.hash === snapshot.hash;
      },
    },
    close: () => store.close(),
  };
}

/**
 * Tell the operator, once, when the cache root sits inside the tree being
 * scanned — a relative `VAT_CACHE_DIR` in a CI workspace, typically, or the
 * default `<tmpdir>/.vat-cache` when the scanned tree contains the temp
 * directory. The message names whichever chose the root. The cache
 * then lives among the files VAT scans and a CI cache save carries it beside
 * the checkout; `$RUNNER_TEMP/vat-cache` is the place for it in GitHub Actions. A notice,
 * not a refusal: the run is still correct.
 *
 * @param root - The absolute corpus root
 */
function noticeCacheRootInsideTree(root: string): void {
  const cacheRoot = vatCacheRoot();
  const tree = `${toForwardSlash(safePath.resolve(root)).replace(/\/$/u, '')}/`;
  if (!`${toForwardSlash(cacheRoot)}/`.startsWith(tree)) return;
  const configured = process.env[VAT_CACHE_DIR_ENV];
  const chosenBy = configured === undefined || configured === ''
    ? `The default cache root (${cacheRoot}, under the temp directory) is inside the scanned tree ${root}. Set ${VAT_CACHE_DIR_ENV} to a directory`
    : `${VAT_CACHE_DIR_ENV} (${cacheRoot}) is inside the scanned tree ${root}. Point it at a directory`;
  noticeToOperator(
    'store',
    `${chosenBy} outside the checkout (in GitHub Actions, $RUNNER_TEMP/vat-cache) so the cache is neither scanned nor saved with the tree.`,
    cacheRoot,
  );
}

/**
 * Load the selected backend, or throw its `BACKEND_UNAVAILABLE` refusal when it is uninstalled.
 *
 * 🪤 Only `ERR_MODULE_NOT_FOUND` means "not installed". A Node older than
 * 22.13.0 has no `node:sqlite` at all and fails with a *different* code, which
 * must propagate as itself: "install this package" would be the wrong repair
 * for "upgrade Node", and diagnosing a version floor as a missing dependency
 * sends a user round a loop that cannot terminate.
 *
 * ## A damaged store file is a miss, not a failed run
 *
 * The store is a cache, and with `VAT_CACHE_DIR` it is one CI saves and
 * restores — so a truncated, corrupt or not-a-database `projection.db` is a
 * real input, not a defect. When the backend reports an EXISTING file it
 * could not open as a database (`isStoreUnopenableError`), the operator is told
 * once on stderr (the path and SQLite's own error), the file is discarded and a
 * fresh store opened in its place; if that fails too, the run carries on with no
 * store, saying so.
 *
 * 🪤 Only the open is forgiven. Any other open failure (a lock, a permission, a path SQLite cannot open,
 * a full disk) still throws, and a store that fails MID-RUN on a read or write
 * still surfaces through `populate()` — a cache that silently stops working is
 * how a week of full-price runs goes unnoticed.
 *
 * @returns The opened store — the engine-free port, which is all the backend's
 *   factory returns, so the population path has no query to grow — or
 *   `undefined` when a damaged store could not be replaced
 */
async function loadStore(): Promise<FactStore | undefined> {
  const backend = await loadBackend();
  try {
    return backend.openSqliteFactStore();
  } catch (error) {
    if (!backend.isStoreUnopenableError(error)) throw error;
    return replaceUnopenableStore(backend, error);
  }
}

/**
 * Discard the store file `error` names and open a fresh one, telling the operator.
 *
 * @param backend - The loaded backend
 * @param error - Its refusal to open the existing file
 * @returns The fresh store, or `undefined` when it could not be replaced
 */
function replaceUnopenableStore(backend: typeof ProjectionSqlite, error: ProjectionSqlite.StoreUnopenableError): FactStore | undefined {
  try {
    backend.discardStoreDatabase(error.databasePath);
    const store = backend.openSqliteFactStore();
    noticeToOperator('store', `${error.message}. Discarded it and started an empty projection store; this run populates without a warm cache.`, error.databasePath);
    return store;
  } catch (retryError) {
    const reason = retryError instanceof Error ? retryError.message : String(retryError);
    noticeToOperator('store', `${error.message}. Could not replace it (${reason}); this run populates without a projection store.`, error.databasePath);
    return undefined;
  }
}

/**
 * Hydrate the run database from one run's projection: the one handle SQL runs on,
 * holding exactly the projection tables the plan names, each with this run's rows.
 *
 * 🔑 **This is what keeps the query surface an ANSWER rather than a privilege.**
 * A caller with no store selected — CI's first run, or a developer who never set
 * the selector — still gets the same SQL over the same schema; the fact store
 * only makes the second run cheap. Without it, "what does this tree contain"
 * would be answerable only where a cache happened to exist, and two callers
 * would hold differently-shaped views of one tree.
 *
 * 🚨 The rows come from `projection` — the run's own population — never from the
 * store: the shared store holds every other repository's rows too. A relation the
 * plan does not name is absent, so a statement reaching it is refused.
 *
 * Nothing survives the close.
 *
 * @param projection - One run's populated projection
 * @param plan - The relations to hydrate, by SQL name
 * @returns The open run database; close it when done
 * @throws Error When the projection has no root row: a driver invariant, since
 *   `populate()` adds exactly one, and without it there is no id to file the
 *   extent-scoped rows under
 */
export async function hydrateRunDatabase(
  projection: Projection,
  plan: Pick<HydrationPlan, 'relations'>,
): Promise<ProjectionSqlite.RunDatabase> {
  // The key is read OFF the projection rather than re-derived from the root.
  // The driver mints `roots.id` with `rootIdFor` and every
  // `resolution_contexts.rootId` is a foreign key into it, so taking it from
  // the rows means the key provably describes them.
  const rootId = projection.roots[0]?.id;
  if (rootId === undefined) {
    throw new Error(
      'The population produced no root row, so there is no id to file its extent under.'
      + ' This is a driver invariant rather than a user error — `populate()` adds exactly'
      + ' one, and a projection without it cannot be stored or queried.',
    );
  }
  const keyOf = new Map(Object.entries(PROJECTION_TABLES).map(([key, spec]) => [spec.name, key as ProjectionTableName]));
  const relations = new Map(plan.relations.map((name) => {
    const key = keyOf.get(name);
    if (key === undefined) throw new Error(`"${name}" is not a projection table, so hydration has no rows for it.`);
    return [name, projection[key]] as const;
  }));
  return (await loadBackend()).hydrateRunDatabase({ rootId, relations });
}

/**
 * Open a compile-only probe over the full queryable schema, derived relations
 * included — for checking statements BEFORE any population or lens has run.
 *
 * ⚠️ Not {@link hydrateRunDatabase}: that database has no table for a relation
 * the run did not hydrate or a lens did not fill, which is how one is refused.
 *
 * @returns An open probe; close it when done
 */
export async function openCompileProbe(): Promise<ProjectionSqlite.ProjectionCompileProbe> {
  return (await loadBackend()).openProjectionCompileProbe();
}

/**
 * Whether a running VAT has the projection store in `directory` open — asked of
 * the backend, which owns the database file's name and its locking.
 *
 * @param directory - A store directory
 * @returns True when another connection holds its database open
 */
export async function storeInUse(directory: string): Promise<boolean> {
  return (await loadBackend()).isStoreInUse(directory);
}

/**
 * Load the selected backend module, or throw its `BACKEND_UNAVAILABLE` refusal when it is uninstalled.
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
    // Thrown into the verb's own catch, which publishes BACKEND_UNAVAILABLE in its shape.
    throw missingBackendError(PROJECTION_STORE_BACKEND);
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
 * always run its SQL on {@link hydrateRunDatabase}, store selected or not, so
 * `node:sqlite` is required on a default `vat resources query` whichever way
 * the lane resolves its store.
 *
 * 🪤 `check` reaches a store only when the project declares checks for it to
 * evaluate, so a repo with none never loads the backend; `query` alone
 * establishes the floor.
 *
 * ✅ **VAT's declared floor is `>=22.16.0` (raised past 22.13.0 for
 * `StatementSync.columns()`), so this does not fire on a SUPPORTED Node.** The branch stays load-bearing
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
    + ' Upgrade Node to the floor `vat doctor` reports. Installing a package will not help:'
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
  /**
   * What the enclosing scope opened, or `undefined` if it opened nothing. Opened
   * on first ask (a scope's store is opened by its first consumer), and the same
   * answer every later time, a refusal included.
   */
  readonly opened: () => Promise<OpenedPopulationCache | undefined>;
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
  const snapshot = gitTreeKey({ cwd: root });
  // 🔑 The tree hash, never "a scope is open". An extent is filed under
  // `(rootId, treeHash)`, so a lane in another repository handed this one's hash
  // would file its extent under a key that does not describe it — silently. Two
  // roots inside ONE repository do share a hash: the key covers the repository.
  return snapshot.ok && snapshot.hash === active.cache.treeHash ? { cache: active.cache } : undefined;
}

/** The scope's store, opened on first ask: the cache, or `undefined` when there is none to give. */
type PopulationCacheOf = () => Promise<PopulationCache | undefined>;

/**
 * Run the work inside a scope whose store is opened on its first ask, and closed
 * when the scope ends if it was opened.
 *
 * A close that fails never decides the outcome. When the work threw, its error
 * is the one rethrown and the close failure is told to the operator — a
 * `finally` that let the close throw would replace the real error. When the
 * work finished, the store is a cache: its result stands, and a close the
 * store or the OS refused (a checkpoint hitting a full disk, say) is a warning,
 * not a failed verb. A close that throws something no OS or SQLite raised is
 * a defect and still surfaces after a successful run.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the scope's store, opened on first ask
 * @returns Whatever `work` returned
 */
async function runOwnedScope<T>(
  options: { root: string },
  work: (cacheOf: PopulationCacheOf) => Promise<T>,
): Promise<T> {
  let opening: Promise<OpenedPopulationCache | undefined> | undefined;
  const opened = (): Promise<OpenedPopulationCache | undefined> => (opening ??= openPopulationCache(options));
  let result: T;
  try {
    // Registered even when nothing is opened, so a nested scope can tell "no
    // store in this process" from "no scope above me" — and so the nested scope
    // stays inside THIS scope's git-snapshot memo either way.
    result = await populationScope.run({ opened }, () => work(async () => (await opened())?.cache));
  } catch (error) {
    await closeTellingOperator(await openedOrNone(opening), { workFailed: true });
    throw error;
  }
  await closeTellingOperator(await openedOrNone(opening), { workFailed: false });
  return result;
}

/**
 * The store a scope opened, if its first ask opened one. A store that refused to
 * open has nothing to close: its refusal was its asker's.
 *
 * @param opening - The scope's open, or `undefined` when nothing asked
 * @returns The opened store, or `undefined`
 */
async function openedOrNone(opening: Promise<OpenedPopulationCache | undefined> | undefined): Promise<OpenedPopulationCache | undefined> {
  if (opening === undefined) return undefined;
  const [settled] = await Promise.allSettled([opening]);
  return settled?.status === 'fulfilled' ? settled.value : undefined;
}

/**
 * Close a scope's store; a failure is told on stderr instead of thrown — see
 * {@link runOwnedScope} for when, and for the one case that still throws.
 *
 * @param opened - The scope's store, if it opened one
 * @param outcome - Whether the scope's work had already failed
 */
async function closeTellingOperator(opened: OpenedPopulationCache | undefined, outcome: { readonly workFailed: boolean }): Promise<void> {
  try {
    await opened?.close();
  } catch (error) {
    const raisedBySystem = error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
    if (!raisedBySystem && !outcome.workFailed) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    noticeToOperator(
      'store',
      `The projection store did not close cleanly (${reason}). `
      + (outcome.workFailed ? 'Reporting the run\'s own failure instead.' : 'The run\'s result stands; the next run reads the cache as it was left.'),
    );
  }
}

/**
 * The scope for `work`: the enclosing one's store when it may be joined, else a
 * scope of its own.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the scope's store, opened on first ask
 * @returns Whatever `work` returned
 */
function withPopulationScope<T>(
  options: { root: string },
  work: (cacheOf: PopulationCacheOf) => Promise<T>,
): Promise<T> {
  try {
    const active = populationScope.getStore();
    if (active !== undefined) {
      // 🪤 No new git bracket on either path: an inner scope stays inside the
      // outer one's memo, which is where the deduplication lives. A fresh bracket
      // here would start an empty memo and re-snapshot the same repository — a
      // dedupe that does nothing while looking exactly like one that works.
      return active.opened().then((opened) => {
        const joinable = joinableCache(opened, options.root);
        return joinable === undefined ? runOwnedScope(options, work) : work(() => Promise.resolve(joinable.cache));
      });
    }
    // ONE git snapshot for the whole scope, and this is the level that gets it:
    // `openPopulationCache` takes one to derive the store key, and the crawl that
    // runs inside `work` takes another to enumerate the extent — same repository,
    // sequentially, ~195 ms and ~159 ms measured on a large monorepo.
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
    // reaches the store through this scope, and a run holds one OUTSIDE all of
    // them, which the nesting above is what makes safe.
    //
    // And the notice scope: the "cannot key this root" notice is printed once per root per
    // command run — this outermost scope's ledger, which every nested scope joins.
    return withNoticeLedger(() => withGitSnapshotCache(() => runOwnedScope(options, work)));
  } catch (error) {
    return Promise.reject(error as Error);
  }
}

/**
 * Run one VAT run's work in a projection-store scope whose store is opened by
 * its first consumer rather than up front.
 *
 * For a run that may finish without enumerating anything: a phase that refuses
 * at its own guards, or finds nothing to check, never opens the store or takes
 * the snapshot that keys it, so its refusal text and stderr are its own. A store
 * that will not open rejects its first asker, and every later asker with the same
 * error (`withRunContext` makes that the run's one refusal). Otherwise the same scope as {@link withPopulationCache}: one
 * snapshot memo, one notice ledger, and nested scopes join it.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the scope's store, opened on first ask
 * @returns Whatever `work` returned
 */
export function withLazyPopulationCache<T>(
  options: { root: string },
  work: (cacheOf: PopulationCacheOf) => Promise<T>,
): Promise<T> {
  return withPopulationScope(options, work);
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
export function withPopulationCache<T>(
  options: { root: string },
  work: (cache: PopulationCache | undefined) => Promise<T>,
): Promise<T> {
  return withPopulationScope(options, async (cacheOf) => work(await cacheOf()));
}
