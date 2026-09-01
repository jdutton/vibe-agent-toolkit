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

import type * as ProjectionSqlite from '@vibe-agent-toolkit/projection-sqlite';
import type { PopulationCache } from '@vibe-agent-toolkit/resources';
import { gitTreeSnapshot, withGitSnapshotCache } from '@vibe-agent-toolkit/utils/git';

import { isModuleMissing, reportMissingBackend, type OptionalBackend } from './optional-backend.js';

/**
 * The env var that selects a projection store for this process.
 *
 * An environment switch rather than a config field, for the same reason
 * `VAT_INVENTORY_CRAWL` and `VAT_RESOURCES_CRAWL` are: it selects which
 * INSTRUMENT runs, not what the project means, and it has to be reachable from
 * the lab, which spawns the binary and controls its environment. A config field
 * would put the A and B arms inside the subject's own tree, where a measurement
 * edits the thing it measures.
 *
 * 🔑 It is read from the environment, and **every phase now runs in the process
 * that read it** — phases used to be child processes inheriting it across a
 * `spawnSync`, which reached the same place by a longer route. `vat validate`'s
 * phases see the same selection their orchestrator did, and can no longer fail
 * to.
 *
 * 🔑 **That sharing has a within-verb instance.** `vat build`'s two
 * phases — `skills build` and `claude plugin build` — both reach the lane
 * through `withResourcePopulationSource` (see `resource-loader.ts`), and both
 * root their population at the same directory, so phase 2 reads the extent
 * phase 1 wrote. Measured on `packages/vat-development-agents` with
 * `VAT_CRAWL_TIMING`: with a cold store phase 1 files `builtin:filesystem`
 * 39.2 ms and `projection-store:write` 10.1 ms, phase 2 files neither and its
 * `resource-registry:enumerate` reads 3.6 ms against phase 1's 66.6 ms.
 *
 * It did NOT need the closure to emit reasons, which is what an earlier reading
 * of this expected: the packaging lanes consume `resource_realizations` and let
 * `walkLinkGraph` keep running on top of the registry, so the base extent alone
 * answers them — the same shape `buildResourcePopulation` already had.
 *
 * The cross-INVOCATION win is unchanged and independent: `vat validate` and
 * `vat verify` spawn a byte-identical `resources validate` child, so the second
 * hits the store.
 *
 * ⚠️ One packaging enumeration is still on the walk: `vat claude plugin build`'s
 * per-skill post-build validation, which reaches `crawlAndResolveRegistry` in
 * `packaging-validator.ts` without a source — its `withResourcePopulationSource`
 * bracket closes around `createProjectRegistry` and does not span the
 * marketplace loop. `vat skills build` no longer does: it holds one bracket over
 * the whole run, and the registry memo is keyed on the population source, so
 * both of its registries source from the projection.
 */
export const PROJECTION_STORE_ENV = 'VAT_PROJECTION_STORE';

/** {@link PROJECTION_STORE_ENV}'s value that selects the SQLite backend. */
export const PROJECTION_STORE_SQLITE = 'sqlite';

/**
 * Where the projection store's database lives, overriding the default.
 *
 * 🪤 **Without this there is no way to isolate a store, and "isolated" test
 * fixtures were not.** `defaultStoreDirectory()` is
 * `tmpdir/.vat-cache/<version>/projection-<shapeDigest>` and consults neither
 * `XDG_CACHE_HOME` nor `HOME`, so a suite that set those believed it had its own
 * database and was writing into the developer's — and on a shared build agent,
 * two concurrent jobs write into one file.
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

/** {@link CACHE_ENV}'s one off value. Exactly `'0'`, never truthiness — see {@link projectionStoreSelected}. */
export const CACHE_DISABLED = '0';

/**
 * The backend as a user is told to install it.
 *
 * Named separately from the RAG backend's entry because the *reason* it ships
 * apart is different, and the install message is the only place a user learns
 * it: RAG carries a platform-native binary, while this one carries a Node
 * version floor.
 */
/** What Node throws for `import('node:sqlite')` before 22.13.0. */
const UNKNOWN_BUILTIN_MODULE = 'ERR_UNKNOWN_BUILTIN_MODULE';

const PROJECTION_STORE_BACKEND: OptionalBackend = {
  feature: 'The projection store',
  packageName: '@vibe-agent-toolkit/projection-sqlite',
};

/**
 * Whether this process should read and write a projection store.
 *
 * **Off unless asked for**, which is the opposite of `vat inventory`'s crawl
 * selector and matches `vat resources scan`'s. A cache changes no answer, so
 * the reason to hold it back is not correctness but evidence: the win is a
 * claim about cost, and a default flipped before the cost is measured on real
 * corpora is a claim nobody checked.
 *
 * Read from the environment at each call rather than memoized at module load:
 * `vitest.setup.js` deletes every `VAT_*` variable before any test module
 * loads, so a module-level binding would make the switch unobservable to every
 * test that sets it.
 *
 * ## The two switches are AND-ed, and the second one is a veto
 *
 * {@link PROJECTION_STORE_ENV} says *which* backend; {@link CACHE_ENV} says
 * whether this run caches at all. A store selected while `VAT_CACHE=0` was
 * measured writing a 9.8 MB, 18,079-row store on this repository and hitting it
 * on the next run — a user who asked for no cache silently got one, and
 * `vat cache`'s own help text described three caches while a fourth was being
 * written beside them.
 *
 * 🪤 Compared against `'0'` exactly, never for truthiness, matching
 * `ParseCache`'s `env['VAT_CACHE'] !== '0'`. `VAT_CACHE=1` is the value an
 * operator writes to turn caching ON, and a truthiness test would read it as a
 * reason to decline.
 *
 * @returns `true` when a store is selected
 */
export function projectionStoreSelected(): boolean {
  if (process.env[CACHE_ENV] === CACHE_DISABLED) return false;
  return process.env[PROJECTION_STORE_ENV] === PROJECTION_STORE_SQLITE;
}

/** An open store, the key half it is used with, and the way to let it go. */
export interface OpenedPopulationCache {
  /** Hand this to `populate()`. */
  readonly cache: PopulationCache;
  /**
   * The same store, typed so it can also be ASKED something.
   *
   * `PopulationCache.store` is `ProjectionStore` — the engine-free contract
   * `@vibe-agent-toolkit/resources` states and every backend implements — and
   * SQL is deliberately not on it (see {@link ProjectionSqlite.SqlQueryableStore}). This is the
   * one field that remembers which backend actually opened, so a query lane does
   * not have to re-open the database or feature-test the object it was handed.
   *
   * ⚠️ The SAME instance, not a second connection. Two connections to one file
   * would be two snapshots, and a query would be free to answer from a tree the
   * population never wrote.
   */
  readonly sql: ProjectionSqlite.SqlQueryableStore;
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
 * `undefined` for an uninstalled backend: a user who set the selector asked for
 * a store, and answering that request by silently not having one is how an
 * opted-in cache becomes an unmeasured one.
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
    process.stderr.write(
      `${PROJECTION_STORE_ENV} is set, but ${options.root} is not inside a readable git`
      + ' repository, so there is no deterministic key to store a projection under.'
      + ' Populating without a cache.\n',
    );
    return undefined;
  }

  const store = await loadStore();
  return {
    cache: { store, treeHash: snapshot.hash },
    sql: store,
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
 * @returns The opened store
 */
async function loadStore(): Promise<ProjectionSqlite.SqlQueryableStore> {
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
 * Load the selected backend module, or report it as uninstalled and exit.
 *
 * @returns The backend's module namespace
 */
async function loadBackend(): Promise<typeof ProjectionSqlite> {
  try {
    return await import('@vibe-agent-toolkit/projection-sqlite');
  } catch (error) {
    if (missingNodeSqlite(error)) {
      throw new Error(
        'The projection store needs `node:sqlite`, which this Node does not have.'
        + ` VAT runs on Node >= 22.0.0, but \`node:sqlite\` arrived in 22.13.0 — you are on ${process.version}.`
        + ' Upgrade Node to 22.13.0 or newer. Installing a package will not help:'
        + ' the module is built into Node, not published to npm.',
      );
    }
    if (!isModuleMissing(error)) throw error;
    reportMissingBackend(PROJECTION_STORE_BACKEND);
  }
}

/**
 * Whether this failure is "your Node is too old", not "the package is absent".
 *
 * 🪤 The two are **different error codes**, and only one of them reaches
 * {@link isModuleMissing}. `@vibe-agent-toolkit/projection-sqlite` imports
 * `node:sqlite`, which arrived in Node 22.13.0; on 22.0–22.12 the import fails
 * with `ERR_UNKNOWN_BUILTIN_MODULE`, not `ERR_MODULE_NOT_FOUND`. Without this
 * branch the user gets a bare `No such built-in module: node:sqlite` — which
 * names neither the version floor nor the fix.
 *
 * ⚠️ This became reachable on EVERY `vat resources query`/`check` run when the
 * query lane started building its in-memory database unconditionally. It is not
 * a corner: VAT's own floor is `>=22.0.0`, so a supported Node hits it.
 *
 * The repair stays distinct from the missing-package one on purpose:
 * "install this package" is the wrong instruction for "upgrade Node", and
 * sending someone round that loop cannot terminate.
 *
 * @param error - Whatever the dynamic import threw
 * @returns True when Node itself lacks the builtin
 */
function missingNodeSqlite(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === UNKNOWN_BUILTIN_MODULE
  );
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
 * inside {@link withOpenedStore}.
 *
 * `undefined` on a run with no store selected, which is the shape every
 * population lane wants: no store means re-derive, not fail.
 *
 * ⚠️ A caller that wants to run SQL must NOT query this store. It is one
 * database per VAT release, shared by every root on the machine, so arbitrary
 * SQL over it answers from other repositories — see `projection-query.ts`.
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
  return withOpenedStore(options, (opened) => work(opened?.cache));
}

/**
 * One git snapshot, one store, closed however the work ends.
 *
 * Still separate from {@link withPopulationCache} rather than inlined into it,
 * because the opened handle carries more than the cache — {@link OpenedPopulationCache.sql}
 * exists for a caller that needs to ASK the store something, and folding this in
 * would make that unreachable without re-opening the database.
 *
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the opened store, or `undefined` when none is selected
 * @returns Whatever `work` returned
 */
async function withOpenedStore<T>(
  options: { root: string },
  work: (opened: OpenedPopulationCache | undefined) => Promise<T>,
): Promise<T> {
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
  // so this one placement covers all of them.
  return withGitSnapshotCache(async () => {
    const opened = await openPopulationCache(options);
    if (opened === undefined) return work(undefined);
    try {
      return await work(opened);
    } finally {
      await opened.close();
    }
  });
}
