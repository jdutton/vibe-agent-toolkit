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

import type { PopulationCache } from '@vibe-agent-toolkit/resources';
import { gitTreeSnapshot } from '@vibe-agent-toolkit/utils';

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
 * 🔑 It is read from the environment and therefore **inherited by every phase
 * child**. `runPhase` passes no `env` to `spawnSync`, so `vat validate`'s
 * children see the same selection their parent did.
 *
 * ⚠️ **That inheritance is the mechanism, and today it has no within-verb
 * instance.** Traced 2026-08-18: of `vat validate`'s and `vat verify`'s phases
 * exactly ONE reaches a projection lane (`resources validate`) and `vat build`
 * reaches none — every other phase builds a registry with no population source
 * and takes the walk. So no verb has two phases that could share an extent. The
 * reachable cross-process win is **cross-invocation**: `vat validate` and
 * `vat verify` spawn a byte-identical `resources validate` child, so the second
 * hits the store. Closing the within-verb gap means converting
 * `packaging-validator.ts` and `skill-packager.ts`, which need reasons the
 * closure does not yet emit — a feature, not this wiring.
 */
export const PROJECTION_STORE_ENV = 'VAT_PROJECTION_STORE';

/** {@link PROJECTION_STORE_ENV}'s value that selects the SQLite backend. */
export const PROJECTION_STORE_SQLITE = 'sqlite';

/**
 * The backend as a user is told to install it.
 *
 * Named separately from the RAG backend's entry because the *reason* it ships
 * apart is different, and the install message is the only place a user learns
 * it: RAG carries a platform-native binary, while this one carries a Node
 * version floor.
 */
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
 * @returns `true` when a store is selected
 */
export function projectionStoreSelected(): boolean {
  return process.env[PROJECTION_STORE_ENV] === PROJECTION_STORE_SQLITE;
}

/** An open store, the key half it is used with, and the way to let it go. */
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
async function loadStore(): Promise<PopulationCache['store']> {
  try {
    const backend = await import('@vibe-agent-toolkit/projection-sqlite');
    return backend.openSqliteProjectionStore();
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
    reportMissingBackend(PROJECTION_STORE_BACKEND);
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
 * @param options - Where the corpus is
 * @param options.root - The absolute corpus root
 * @param work - Given the cache, or `undefined` when there is none to give
 * @returns Whatever `work` returned
 */
export async function withPopulationCache<T>(
  options: { root: string },
  work: (cache: PopulationCache | undefined) => Promise<T>,
): Promise<T> {
  const opened = await openPopulationCache(options);
  if (opened === undefined) return work(undefined);
  try {
    return await work(opened.cache);
  } finally {
    await opened.close();
  }
}
