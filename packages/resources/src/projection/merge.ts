/**
 * The stratified merge driver (zones.md §7.2).
 *
 * §7.2, verbatim: *"Merge is an explicit fixpoint over a stratified dependency
 * graph. Acyclic strata get one pass; the closure stratum iterates to a fixed
 * point with a declared iteration cap and loud failure on non-convergence."*
 *
 * So {@link populate} does exactly two things, in this order:
 *
 * 1. Every `base` contributor runs **once**. What git tracks, what is on disk,
 *    what a package manifest declares — none of it depends on what another
 *    contributor found, so a second pass could only re-derive the same rows.
 * 2. {@link populateBlobs} derives the four blob-keyed tables from the content
 *    keys the base recorded. Not a contributor — it declares no extent — but
 *    the position is forced: the base is what produces `contentKey` columns and
 *    the closure stratum is what *reads* `blob_references`. Without it every
 *    closure extent is its declared root and nothing else, and the run reports
 *    success. See `blob-population.ts`.
 * 3. Every `closure` contributor runs **repeatedly against the growing base**
 *    until no contributor's {@link extentDigest} moved during a whole pass.
 * 4. If the closure stratum promoted any `deferred` realization to `keyed` —
 *    demand-driven keying, `ProjectionBuilder.ensureContentKey` —
 *    {@link populateBlobs} runs once more, so the newly keyed paths get the
 *    `blobs` rows their realizations now name. Strictly after the fixpoint: see
 *    {@link afterClosurePromotion}.
 *
 * ## A store short-circuits all of it, or none of it
 *
 * With a {@link PopulationCache}, the driver asks the store first and returns a
 * hydrated projection when the store already holds an answer to *this* question
 * — see `store-hydration.ts` for what makes a stored extent an answer to one run
 * and not another. On a miss the four steps above run exactly as they always
 * have, and what they produced is written back.
 *
 * It is deliberately all-or-nothing. A partial hit — "the base is stored, run
 * the closure over it" — would need the base's *builder* rather than its rows,
 * and would make the fixpoint's convergence claim rest on rows no contributor in
 * this process emitted. The cheap, checkable version is the whole run or none of
 * it.
 *
 * ## Non-convergence throws, and never returns what it reached
 *
 * A driver that capped the loop and returned would hand back a *truncated*
 * extent labelled complete, which is the failure mode the whole zone model
 * exists to prevent: `zone_provenance.extentDigest` is non-nullable precisely
 * because a partially-populated extent and a fully-populated one are
 * indistinguishable from the row set alone. So the cap raises
 * {@link ClosureNonConvergenceError}, which names the contributors still moving
 * so the loop is diagnosable rather than merely detected.
 *
 * ## Why the confirming pass is not waste
 *
 * Convergence is only observable in arrears: a contributor's digest is "stable"
 * only once it has been computed twice against two different bases. A contributor
 * whose own output has settled is therefore still re-invoked while any *other*
 * closure contributor is moving — its input, the shared base, is still changing,
 * so a per-contributor "it stopped, skip it" optimisation would freeze it at a
 * base that no longer exists. Every closure contributor runs in every pass; the
 * loop ends on the first pass in which none of them moved.
 */

import {
  CRAWL_BLOB_POPULATE_ID,
  CRAWL_STORE_READ_ID,
  CRAWL_STORE_WRITE_ID,
  crawlTimingStart,
  forEachInOrder,
  recordContributorInvocation,
  recordCrawlPass,
  safePath,
  VatError,
  withContributorStratum,
} from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import { type ParseDispatcher, withParseDispatcher } from '../parse-dispatcher.js';
import type { CollectionConfig } from '../schemas/project-config.js';
import type { RealizationConditionRow, ResourceRealizationRow } from '../schemas/projection-resources.js';
import type { JsonValue } from '../schemas/projection-shared.js';

import { PARSE_REFUSAL_BLOB_CODES, populateBlobs, storableBlobFacts } from './blob-population.js';
import { POPULATION_PARSE_LIMITS, RunContentCache } from './content-cache.js';
import type { ContributorRegistry, ExtentContribution, ExtentContributor } from './contributor.js';
import {
  declinedSymlinkRowsStillHold,
  EXTENT_DIRECTORY_UNLISTABLE,
  unlistableRowStillHolds,
} from './contributors/filesystem-extent.js';
import { crawlSourceSelector } from './crawl-source.js';
import { canonicalJson, extentDigest } from './digest.js';
import {
  assertHarnessSettled,
  dispatcherHarnessFacts,
  diskHarnessContentReader,
  harnessUnsettledKeys,
  runHarnessPass,
} from './harness/harness-pass.js';
import { HARNESS_PROFILES, type HarnessProfile } from './harness/profile.js';
import { rootIdFor } from './identity.js';
import { ProjectionBuilder, type Projection } from './projection.js';
import {
  collectionMimeConflictCondition,
  createCollectionMimeResolver,
  type CollectionMimeResolver,
} from './realizations.js';
import {
  assembleProjection,
  emptyBlobRows,
  keyedContentKeys,
  selectRequestedContexts,
  selectRequestedRows,
  uncoveredContentKeys,
  type RequestedContributor,
} from './store-hydration.js';
import {
  splitProjectionByScope,
  type ExtentKey,
  type ExtentScopedRows,
  type ProjectionStore,
} from './store.js';

/**
 * The pass number every driver-placed row in the `base` stratum carries.
 *
 * Base contributors run exactly once — there is no fixpoint over them — so the
 * driver numbers them 1 and never anything else, and the blob stage sits in the
 * same round. Named rather than written as a literal at three sites because it is
 * what makes those rows ADDITIVE to the reader: `crawlRowRole` treats pass >= 1 as
 * "safe to add" whatever the stratum, and reserves pass 0 for a bracket placed
 * inside a contributor invocation. A stray 0 here would silently reclassify real
 * work as a nested breakdown of a row that does not contain it.
 */
const BASE_STRATUM_PASS = 1;

/**
 * Closure passes allowed before {@link populate} gives up.
 *
 * **Measured, and this number is four times the measurement.** A
 * whole-corpus population of the vibe-agent-toolkit repository with all six
 * shipped contributors registered — 61 skill extents, plus plugin and
 * marketplace, 66 contributors in total — reached its fixed point on **pass 2**:
 * one productive pass, then one confirming pass in which no digest moved. No
 * contributor needed a third. (`projection-population.system.test.ts`,
 * which re-runs the probe and fails if the depth ever regresses.)
 *
 * Depth 2 is the *structural* answer, not a property of corpus size: a closure
 * contributor's output is a function of the base's paths and `blob_references`,
 * neither of which a closure pass can add to, so the only thing that can carry a
 * stratum past pass 2 is one closure contributor reading another's rows. Exactly
 * one such dependency ships (`PluginExtentContributor` absorbs nested `skill`
 * extents), and it costs a pass only when the plugin contributor is registered
 * *before* the skill contributors — registration order, not corpus content.
 *
 * So the headroom is for depth in the contributor graph, which is what could
 * plausibly grow: 8 admits a chain of closure-reads-closure four levels deeper
 * than anything shipped, while still failing a genuine cycle in seconds rather
 * than grinding through a whole-corpus pass ten times.
 */
const DEFAULT_MAX_ITERATIONS = 8;

/**
 * Parse the content of every distinct keyed path, deriving the four blob-keyed
 * tables from it — {@link PopulateOptions.contentParsing}'s default.
 */
export const CONTENT_PARSING_DERIVE = 'derive';

/**
 * Read and parse nothing, leaving the four blob-keyed tables empty — only sound
 * when nothing reads them.
 */
export const CONTENT_PARSING_SKIP = 'skip';

/** What {@link PopulateOptions.contentParsing} accepts. */
export type ContentParsing = typeof CONTENT_PARSING_DERIVE | typeof CONTENT_PARSING_SKIP;

/** What a population run needs to know. */
export interface PopulateOptions {
  /** Absolute corpus root every contributor's paths are relative to. */
  root: string;
  /** The contributors to run, already partitioned by stratum. */
  registry: ContributorRegistry;
  /**
   * The run's git oracle, or absent outside a repository.
   *
   * Shared with every contributor through {@link ProjectionBase.gitTracker}: one
   * `git ls-files` spawn per run rather than one per contributor, and — the part
   * that is correctness rather than cost — one answer to the index-casing
   * question that identity minting depends on.
   */
  gitTracker?: GitTracker | undefined;
  /**
   * Per-contributor parameter sets, keyed by {@link ExtentContributor.id}.
   *
   * This is also §7.3's closure primitive: a closure-defined extent is a
   * *generic* contributor handed a declaration, and the declaration travels here
   * rather than in a constructor. That is not a stylistic preference —
   * §7.4 requires `zone_provenance.parameterSet` to be "the parameters this
   * contributor ran under, verbatim", and a declaration hidden in a constructor
   * would leave a provenance row that under-describes the very extent its digest
   * is supposed to make comparable.
   *
   * A contributor with no entry runs under `null`.
   */
  parameters?: Record<string, JsonValue> | undefined;
  /** Closure passes allowed before the run fails. Defaults to {@link DEFAULT_MAX_ITERATIONS}. */
  maxIterations?: number | undefined;
  /**
   * Whether this run reads and parses file content. Defaults to
   * {@link CONTENT_PARSING_DERIVE}.
   *
   * ## What is and is not gated
   *
   * Gated: the blob-derivation stage — one read-and-parse of **every distinct
   * keyed path**, and the four blob-keyed tables (`blobs`, `blob_references`,
   * `blob_sections`, `blob_conditions`) derived from it; the store's blob tier
   * on both the read-back and write-back paths; and the post-fixpoint re-run
   * that would pick up a demand promotion.
   *
   * **Not** gated: the closure stratum, which iterates to its fixpoint either
   * way. That is what makes `'skip'` dangerous rather than merely thrifty — a
   * closure contributor still runs, reads an empty `blob_references`, and
   * converges on pass one with its extent reduced to its declared root. Hence
   * the refusal below.
   *
   * ## Why a caller decision at all
   *
   * The stage reads and parses **every distinct keyed path**, not the resources
   * among them, and on a caller that reads no blob table that is the whole cost
   * of the lane. Measured on this repository, `vat resources scan` over 2,096
   * tracked files of which 176 are admitted resources: 6,839 ms of 7,615 ms cold
   * — 90% — when that verb skipped the stage; the walker arm is 1,363 ms. The
   * resources lanes now run it so membership and query share one stored
   * population; the claude-context discovery pass is the one caller that skips.
   *
   * ## Why `'skip'` is opt-in and cannot be inferred
   *
   * Whether the blob tables are read is only half knowable from here. The driver
   * can see which registered contributors read them
   * ({@link ContributorRegistry.blobReaders}); it cannot see what the CALLER
   * does with the returned `Projection`. Inferring `'skip'` from "no registered
   * blob reader" would silently empty four tables under a caller that queries
   * them — token estimates and section trees are exactly the sort of thing a
   * lens reads with no contributor involved.
   *
   * So the caller asks, and the driver refuses an unsound request: `'skip'` with
   * a blob reader registered **throws**, naming the contributor. That is what
   * stops the flag going stale — add a closure extent to a skipping caller later
   * and the run fails loudly instead of converging on iteration one with every
   * extent reduced to its own root.
   */
  contentParsing?: ContentParsing | undefined;
  /**
   * Receives one record per contributor invocation, as it completes.
   *
   * It exists because the cost of a run is a fact about the *run*, and a
   * projection is rows, so there is nowhere in the returned tables to put it.
   *
   * **This is the seam that makes a slow population diagnosable at all.** Without
   * it `populate` is one opaque await, and locating a hot spot means bisecting by
   * re-running with contributor subsets — which is how the two defects this seam
   * was added for were found, at a cost of several whole-corpus runs each. A
   * caller that prints these records gets the same answer from one run.
   *
   * `pass` is 1 for every base contributor and the fixpoint iteration number for
   * a closure one, so a contributor that is cheap once but runs in every pass is
   * distinguishable from one that is expensive once.
   *
   * **A test seam, with no production caller — and optional because the
   * production route does not need one.** Every record is also filed with
   * `crawl-timing.ts`, which dumps them when `VAT_CRAWL_TIMING` is set (see
   * {@link reportContributorTiming}); that dump is what `vat` and the lab read,
   * so omitting this observer loses nothing a shipped command reports. Its
   * callers are tests that need the records in-process: the store-sharing child,
   * which proves a hit by the ABSENCE of contributor work, and the crawl-timing
   * and store round-trip suites. Before they existed it had no observer anywhere
   * in the repository, which meant both brackets below could have been deleted
   * with nothing failing.
   */
  onContributorTiming?: ((timing: ContributorTiming) => void) | undefined;
  /**
   * A store to answer this population from, and to record it in on a miss.
   *
   * Omitted, every run re-derives — which is what shipped, and is still the
   * default. See {@link PopulationCache}.
   */
  cache?: PopulationCache | undefined;
  /**
   * The project's `resources.collections`, so a declared `mimeType` can route
   * the file it matches to a parser.
   *
   * Omitted, every path is typed by `mime-type.ts`'s tables alone — which is
   * what every caller outside a configured project wants and what every caller
   * that has not opted in continues to get.
   *
   * The raw config, not a resolver: {@link populate} builds the run's
   * {@link CollectionMimeResolver} from it exactly once, beside the run's
   * content cache and for the same reason. The resolver ACCUMULATES conflicts,
   * so its lifetime has to be the population's — two extents handed two
   * resolvers would report one authoring mistake twice, and
   * {@link ProjectionBuilder.ensureContentKey} explicitly relies on there being
   * exactly one ("two rows at one path cannot disagree unless a caller hands two
   * extents two different resolvers").
   */
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
}

/**
 * The two shared run inputs a population lane forwards to {@link populate}.
 *
 * Both are genuinely optional and both are typed `T | undefined` under
 * `exactOptionalPropertyTypes`, which is why every lane spells them as a
 * conditional spread rather than passing `undefined`: the two are different
 * states, and `{ cache: undefined }` is not the same request as omitting
 * `cache`. Restated once here because three lanes were each writing the same
 * pair of spreads, and a fourth would have written a fourth copy — one of which
 * would eventually pass `undefined` and quietly change what the store is asked.
 *
 * @param options - Whatever the lane received from ITS caller
 * @returns A spreadable object carrying only the oracles that are actually present
 */
export function populationOracles(options: {
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
}): Pick<PopulateOptions, 'gitTracker' | 'cache' | 'collections'> {
  return {
    ...(options.gitTracker !== undefined && { gitTracker: options.gitTracker }),
    ...(options.cache !== undefined && { cache: options.cache }),
    ...(options.collections !== undefined && { collections: options.collections }),
  };
}

/**
 * The store this run may read from and will write to, and the tree it names.
 *
 * One object rather than two options, because neither half is usable alone: a
 * store with no tree hash has no key, and a tree hash with no store has nothing
 * to ask.
 *
 * The `rootId` half of {@link ExtentKey} is deliberately **not** here.
 * `populate()` derives it from `root` with the same `rootIdFor` the identity map
 * uses, so a caller cannot hand the store one root's hash filed under another
 * root's id — which would be a silent cross-corpus hit, the one failure a cache
 * key exists to make impossible.
 */
export interface PopulationCache {
  /** The backend. `resources` never selects one; a caller supplies it. */
  readonly store: ProjectionStore;
  /**
   * A hash naming this tree's exact contents — see {@link ExtentKey.treeHash}.
   *
   * In a repository, `@vibe-validate/git`'s dirty-corrected `write-tree` hash
   * (`gitTreeSnapshot().hash`), which covers unstaged edits and untracked files
   * and carries no timestamp. 🪤 Never `git stash create`, whose commit object
   * does — two calls over byte-identical content would disagree and every read
   * would miss.
   *
   * ⚠️ That hash covers the whole **repository**, not the subtree `root` names.
   * An edit anywhere in the repository therefore cools the cache for every root
   * inside it. Conservative in the safe direction, and cheap to be conservative
   * about: `git write-tree` against a throwaway index is the same call
   * `vibe-validate` makes on every commit.
   */
  readonly treeHash: string;
  /**
   * Does {@link treeHash} still describe the tree, asked NOW?
   *
   * ⛔ Required, and asked before an extent is filed. The hash is taken when the
   * run starts and the rows are what it reads afterwards; an edit landing in
   * between filed the edited rows under the unedited key, and once the edit was
   * reverted every later run was served them. A run whose tree moved files
   * nothing, so the next run derives instead of hitting.
   *
   * ⚠️ An edit made AND reverted entirely inside one run is not seen — both
   * snapshots agree. The window is the run itself rather than every run after it.
   */
  treeUnchanged(): boolean;
}

/**
 * What a population did with the store — the ONE source of whether its rows were
 * served or derived.
 *
 * A correct hit and a correct re-derivation produce identical rows, so provenance
 * cannot be inferred from the projection; it is reported by the run that knows.
 * `population` is a function of `stored` (`hit` ⇒ `'store'`, every other value ⇒
 * `'derived'`), and the union makes that the TYPE: a pair that disagrees does not
 * compile.
 *
 * - `hit` — served from the store; no contributor ran.
 * - `written` — derived, and the extent was filed.
 * - `skipped-tree-changed` — derived, and the extent was NOT filed because the
 *   tree moved during the run (see {@link PopulationCache.treeUnchanged}).
 * - `no-store` — derived, with no store to read or write.
 *
 * A derived run also carries `storeMiss` when the store held this population's
 * extent and missed only because of pairs this run refused — see {@link StoreMiss}.
 */
export type PopulationOutcome =
  | { readonly population: 'store'; readonly stored: 'hit' }
  | {
    readonly population: 'derived';
    readonly stored: 'written' | 'skipped-tree-changed' | 'no-store';
    readonly storeMiss?: StoreMiss;
  };

/**
 * A store miss a refusal caused, counted (ADR I10: misses are counted and named).
 *
 * A refused parse is filed nowhere (I6), so its key — or its `(blob, harness)`
 * pair — is held by no store, and while the refusal persists the store can
 * never serve the population: every run re-derives all of it. That cost is
 * allowed only when it is visible, so the run that pays it says so.
 */
export interface StoreMiss {
  /** The pairs the store lacked that this run refused again. */
  readonly refusedPairs: number;
}

/**
 * @param outcome - What `populate` said about the run
 * @returns The store miss a refusal caused it, if one did
 */
export function storeMissOf(outcome: PopulationOutcome): StoreMiss | undefined {
  return outcome.population === 'derived' ? outcome.storeMiss : undefined;
}

/**
 * The sentence a run whose store miss a refusal caused reports it with.
 *
 * @param storeMiss - The run's {@link storeMissOf}
 * @returns The sentence, or `undefined` when no refusal cost the store a hit
 */
export function describeStoreMiss(storeMiss: StoreMiss | undefined): string | undefined {
  if (storeMiss === undefined) return undefined;
  const count = storeMiss.refusedPairs;
  const noun = count === 1 ? 'pair is' : 'pairs are';
  return `store miss: ${String(count)} refused ${noun} held by no store, so the whole population was re-derived; it is re-derived on every run while the refusal persists`;
}

/**
 * Each `population` value, keyed so the compiler checks the list against
 * {@link PopulationOutcome} both ways: a value missing from the union, or a
 * union member missing here, does not compile.
 */
const POPULATION_ORIGIN_SET: Readonly<Record<PopulationOutcome['population'], true>> = { store: true, derived: true };

/**
 * Every `population` a {@link PopulationOutcome} can carry, as a runtime list —
 * for a schema that must enumerate them. Derived from the union, never typed
 * beside it.
 */
export const POPULATION_ORIGINS = Object.keys(POPULATION_ORIGIN_SET) as [
  PopulationOutcome['population'],
  ...Array<PopulationOutcome['population']>,
];

/**
 * The outcome a `stored` value implies — the only construction of one.
 *
 * @param stored - What the run did with the store
 * @returns The outcome, with `population` derived from `stored`
 */
function populationOutcome(stored: PopulationOutcome['stored'], storeMiss?: StoreMiss): PopulationOutcome {
  if (stored === 'hit') return { population: 'store', stored };
  return storeMiss === undefined ? { population: 'derived', stored } : { population: 'derived', stored, storeMiss };
}

/**
 * How many of the pairs a store lacked this derivation refused again.
 *
 * @param missed - One content key per pair the store lacked
 * @param projection - What this run derived
 * @returns The count, or `undefined` when no refusal explains the miss
 */
function storeMissFor(missed: readonly string[], projection: Projection): StoreMiss | undefined {
  if (missed.length === 0) return undefined;
  const refused = new Set(
    projection.blobConditions.filter((row) => PARSE_REFUSAL_BLOB_CODES.has(row.code)).map((row) => row.blob),
  );
  const refusedPairs = missed.filter((key) => refused.has(key)).length;
  return refusedPairs === 0 ? undefined : { refusedPairs };
}

/**
 * What {@link populate} returns: the rows, and where they came from.
 *
 * Provenance travels BESIDE the projection rather than on it, because
 * `Projection`'s keys are its table set and everything that iterates them
 * (`splitProjectionByScope`, the exporter) would have to learn to skip a field.
 */
export interface PopulateResult {
  readonly projection: Projection;
  readonly outcome: PopulationOutcome;
}

/**
 * What a whole-tree population lane is asked: the resources projection and the
 * Claude-context population take exactly this, and each documents what every
 * field means to it.
 */
export interface TreePopulationOptions {
  root: string;
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
}

/** What one contributor invocation cost. */
export interface ContributorTiming {
  /** The contributor's {@link ExtentContributor.id}. */
  readonly contributorId: string;
  /** Which stratum it ran in. */
  readonly stratum: 'base' | 'closure';
  /** 1 for a base contributor; the fixpoint iteration for a closure one. */
  readonly pass: number;
  /**
   * Wall time this invocation took, in milliseconds.
   *
   * From `performance.now()`, not `Date.now()`. The difference is not cosmetic:
   * the same figures are filed with `crawl-timing.ts` alongside the link
   * walker's, and the point of putting them in one dump is that the two crawlers
   * can be held against each other. `Date.now()`'s ~1ms granularity would have
   * quantised every contributor invocation on one side of that comparison while
   * the other side was sub-microsecond, which is precisely the resolution the
   * comparison needs.
   */
  readonly elapsedMs: number;
}

/**
 * File one contributor invocation with the seam, and with the caller if it asked.
 *
 * One measurement, two destinations, and the SAME object handed to both — so an
 * in-process observer and the on-disk dump can never report different numbers for
 * one invocation.
 *
 * @param onTiming - The caller's observer, if any
 * @param timing - What the invocation cost
 */
function reportContributorTiming(
  onTiming: ((timing: ContributorTiming) => void) | undefined,
  timing: ContributorTiming,
): void {
  recordContributorInvocation(timing);
  onTiming?.(timing);
}

/**
 * The closure stratum did not reach a fixed point within the declared cap.
 *
 * Thrown instead of returning the extent reached so far: a truncated extent
 * reported as complete is a confident wrong answer, and every consumer of a
 * projection reads it as a complete one.
 */
export class ClosureNonConvergenceError extends VatError {
  /**
   * Contributors whose digest still changed on the final pass.
   *
   * The diagnosable half of the failure — a cycle is normally between two named
   * closure declarations, and this is the pair.
   */
  readonly contributorIds: readonly string[];

  /**
   * How many **passes over the whole closure stratum** were run.
   *
   * The unit is a pass, not a contributor invocation: with three closure
   * contributors, `iterations === 4` means twelve `contribute` calls.
   */
  readonly iterations: number;

  /**
   * @param contributorIds - Ids whose digest moved on the final pass
   * @param iterations - Passes run before giving up
   */
  constructor(contributorIds: readonly string[], iterations: number) {
    const moving = contributorIds.length > 0 ? contributorIds.join(', ') : '(none recorded)';
    super(
      'CLOSURE_NON_CONVERGENCE',
      `The closure stratum did not converge after ${iterations} pass(es) over it.`
      + ` Still moving: ${moving}.`
      + ' Returning the extent reached so far would report a truncated extent as a complete one,'
      + ' so this is an error rather than a capped result.',
    );
    this.contributorIds = [...contributorIds];
    this.iterations = iterations;
  }
}

/**
 * Run every contributor and return the merged projection.
 *
 * Base contributors are **not** insulated from each other: one that throws
 * aborts the run. `GitExtentContributor` throwing outside a repository is the
 * motivating case — catching it would produce a projection with no git extent
 * and no record that git was ever asked, which is exactly the empty-extent-as-a-
 * result posture `ContributorRegistry.forKind` already refuses.
 *
 * @param options - Root, contributors, per-contributor parameters and the cap
 * @returns The frozen projection every registered contributor agreed on, and
 *   the {@link PopulationOutcome} that says whether the store served it
 * @throws {@link ClosureNonConvergenceError} when the closure stratum is still
 *   moving after `maxIterations` passes
 * @throws Whatever a contributor throws — failures propagate unwrapped
 */
export async function populate(options: PopulateOptions): Promise<PopulateResult> {
  const { root } = options;

  // Resolved BEFORE anything else, and deliberately before the cache is asked:
  // it refuses an unsound `'skip'` request by throwing, and a run that would
  // have been refused must not be silently served from a store instead. The
  // request's soundness is a property of the registry, not of the cache's luck.
  const parseContent = contentParsingFor(options);

  // BEFORE the cache is asked, because the cache KEY depends on it: two runs
  // routing differently ask different questions of the same tree, and serving
  // one the other's answer is the false hit `storeKeyFor` folds `parseRouting`
  // in to prevent. Built here and nowhere else so its lifetime is this run's —
  // it accumulates conflicts, and a second instance would report one authoring
  // mistake twice.
  const routing = createCollectionMimeResolver(options.collections);

  // Same `rootIdFor` the identity map mints `roots.id` with — see
  // {@link PopulationCache} on why the caller does not supply it.
  const rootId = rootIdFor(root);
  const cached = await readCachedProjection(options, rootId, parseContent, routing);
  if ('hit' in cached) {
    return { projection: cached.hit, outcome: populationOutcome('hit') };
  }

  // ONE dispatcher for the run — the blob stage's parses, the post-promotion
  // re-run's, and every harness pass's memory-file reads share its one pool —
  // shut down however the derivation ends. Built lazily: a run that parses
  // nothing starts no worker.
  const projection = await withParseDispatcher(
    (dispatcher) => deriveProjection(options, { parseContent, routing, dispatcher }),
    { policy: { limits: POPULATION_PARSE_LIMITS } },
  );
  const stored = await writeCachedProjection(options, rootId, parseContent, projection, routing);
  return { projection, outcome: populationOutcome(stored, storeMissFor(cached.missed, projection)) };
}

/**
 * What the store answered: the population, or the pairs it lacked — one content
 * key per pair, empty when it held no extent for this question at all.
 */
type CachedRead = { readonly hit: Projection } | { readonly missed: readonly string[] };

/** A store that held nothing for this question. */
const NOTHING_HELD: CachedRead = { missed: [] };

/** What {@link populate} decided before deriving, and the run's one dispatcher. */
interface DerivationRun {
  /** Whether this run reads and parses content. */
  readonly parseContent: boolean;
  /** The run's parse routing. */
  readonly routing: CollectionMimeResolver;
  /** The run's dispatcher: every parse, and every harness's memory-file read. */
  readonly dispatcher: ParseDispatcher;
}

/**
 * Derive the projection: every contributor, the blob stage, the harness passes
 * and the closure fixpoint, into one builder — {@link populate} on a store miss.
 *
 * @param options - The run's options
 * @param run - The run's parse decision, routing and dispatcher
 * @returns The frozen projection
 */
async function deriveProjection(options: PopulateOptions, run: DerivationRun): Promise<Projection> {
  const { root, registry, parameters, maxIterations = DEFAULT_MAX_ITERATIONS } = options;
  const { parseContent, routing, dispatcher } = run;
  // Constructed here and nowhere else, so its lifetime is exactly this run's.
  // A module-level cache would leak bytes across two populations in one process
  // — including two populations of a tree that changed in between, which would
  // describe the wrong corpus with complete confidence.
  const builder = new ProjectionBuilder({
    root,
    gitTracker: options.gitTracker,
    // Held to POPULATION_PARSE_LIMITS, the cap the dispatcher runs under, so a file a parser would
    // refuse by size is refused before it is read.
    contentCache: new RunContentCache(),
    mimeResolver: routing,
  });

  // The `roots` row no contributor can produce: `ExtentContribution` has no
  // `roots` table, yet every `resolution_contexts.rootId` is a foreign key into
  // one. The driver is the only participant that knows both the path and the id
  // the shared identity map minted from it.
  builder.addRoot({ id: builder.identities.rootId, path: safePath.resolve(root) });

  const parameterSetFor = (contributor: ExtentContributor): JsonValue =>
    parameters?.[contributor.id] ?? null;

  // Sequential on purpose: each contributor reads the base the previous ones
  // grew, and `ResourceIdentityMap` is a shared memo rather than a pure
  // function. Fanning these out with `Promise.all` would make the row set
  // depend on scheduling.
  await forEachInOrder(registry.byStratum('base'), async (contributor) => {
    const startedAt = performance.now();
    // Wrapped so that any crawl-timing bracket reached from inside this
    // contributor is attributed to the PROJECTION arm rather than to the
    // incumbent's. Only `ResourceRegistry` currently records without naming its
    // own stratum, and nothing under `projection/` builds one — but the rule has
    // to be in place before the first commit that does, or that commit moves a
    // whole registry build onto the walker's total. See `crawl-timing.ts`.
    await withContributorStratum('base', () =>
      runContributor(contributor, builder, parameterSetFor(contributor)),
    );
    reportContributorTiming(options.onContributorTiming, {
      contributorId: contributor.id,
      stratum: 'base',
      pass: BASE_STRATUM_PASS,
      elapsedMs: performance.now() - startedAt,
    });
  });

  // Between the strata. The base is what records `contentKey` columns; the
  // closure stratum is what reads `blob_references`. A closure contributor only
  // ever re-realizes a path the base already realized, so the *only* way a new
  // content key can appear after this is an explicit demand promotion — which
  // `afterClosurePromotion` below picks up, after the fixpoint.
  //
  // Nothing observes the stage's counters: what a user is told about refused
  // content is read from the rows it writes, which a store hit returns too.
  if (parseContent) await runBlobStage(builder, dispatcher);
  const attemptsBeforeClosure = builder.contentPromotionAttempts;

  // The harness facts, LAZILY: derived only for what a harness reaches. Before
  // the closure stratum, because its contributors read them (in `frontier`
  // mode, where a blob with no facts yet contributes nothing that pass); inside
  // every fixpoint iteration, because a declared closure's members arrive
  // there; and once more after the promotion, which can key a reachable path.
  // Under `'skip'` no blob has a `blobs` row, so there is nothing to reach.
  const harness = harnessStageFor(builder, dispatcher);
  await harness.run();

  await iterateClosure(
    registry.byStratum('closure'),
    builder,
    parameterSetFor,
    maxIterations,
    harness,
    options.onContributorTiming,
  );

  if (parseContent) await afterClosurePromotion(builder, attemptsBeforeClosure, dispatcher);
  await harness.run();
  // A reached blob with no facts after the last pass is a producer bug: every
  // strict reader of this projection would throw on it later, far from here.
  harness.assertSettled();

  // AFTER every contributor, and the reason is the CLOSURE stratum's extra
  // realization ROWS, not extra conflicts. ⚠️ It is not that "a closure
  // contributor can realize a path the base did not" — `walkClosure` copies the
  // base row (`closure-extent.ts:437-447`, whose own comment says it "does not
  // re-observe the path") and returns `unrealized` for anything the base missed,
  // so it never calls `mimeFor` and can contribute ZERO new conflicts. What it
  // does add is a new `(extentId, path)` realization for an already-conflicted
  // path — and running earlier would leave those closure rows carrying a `mime`
  // with no condition explaining it, which is exactly the per-realizing-extent
  // rule the fan-out below argues for.
  // Before `build()`, because a frozen projection takes no more rows.
  recordMimeConflicts(builder, routing);

  return builder.build();
}

/**
 * Turn the run's collection-MIME conflicts into `realization_conditions` rows.
 *
 * ## One row per REALIZING EXTENT, not one per path
 *
 * A condition is keyed on `(extentId, path)` like the realization it is about —
 * the rule {@link ProjectionBuilder.ensureContentKey} states for its own
 * unreadable case. A single row for the path would leave every other extent's
 * realization of that file carrying a type nothing explains.
 *
 * A conflicted path that NO extent realized emits nothing, and that is correct
 * rather than a silence: `mimeFor` is only ever called while realizing, so a
 * conflict cannot exist without at least one realization behind it. The
 * `resourceId` is read off the realization rather than re-derived, because the
 * identity is the extent's answer and not this function's to mint.
 *
 * @param builder - The builder to add conditions to
 * @param routing - The run's routing, holding every conflict it recorded
 */
function recordMimeConflicts(builder: ProjectionBuilder, routing: CollectionMimeResolver): void {
  if (routing.conflicts.length === 0) return;

  const realizationsByPath = new Map<string, ResourceRealizationRow[]>();
  for (const row of builder.base().resourceRealizations) {
    const rows = realizationsByPath.get(row.path) ?? [];
    rows.push(row);
    realizationsByPath.set(row.path, rows);
  }

  for (const conflict of routing.conflicts) {
    for (const row of realizationsByPath.get(conflict.path) ?? []) {
      builder.addCondition(collectionMimeConflictCondition(conflict, row.extentId, row.resourceId));
    }
  }
}

/**
 * The store key for this run — the tree, plus the ambient inputs that change
 * what a contributor puts in it.
 *
 * ## 🪤 Why the tree hash alone is not the key
 *
 * The reuse rule compares `(contributorId, parameterSet)`, which is the right
 * question and is still not sufficient: a contributor can read inputs that
 * appear in **no** parameter set. `FilesystemExtentContributor` has a fixed id,
 * always runs under `null`, and reads two of them —
 *
 * | input | reaches it via | what it changes |
 * |---|---|---|
 * | a {@link GitTracker} | {@link ProjectionBase.gitTracker} | every realization's `gitignored`; with no tracker the whole column is `false` |
 * | {@link EXTENT_SOURCE_ENV} | {@link crawlSourceFor} at construction | which enumerator produces the extent at all |
 *
 * — so without this, `VAT_EXTENT_SOURCE=git vat inventory` followed by a plain
 * `vat inventory` over an unchanged tree is a **false hit**: same key, same
 * question, materially different rows, exit 0. {@link PopulateOptions.parameters}
 * already argues that a declaration hidden in a *constructor* leaves a
 * provenance row that under-describes its own extent; these are the same fault
 * arriving through the base and through the environment instead.
 *
 * ## Why this is NOT the rejected "request digest in the tree hash"
 *
 * Folding a digest of the *request* into `treeHash` is a settled do-not: it
 * gives two commands disjoint keys, so they share nothing but the blob tier,
 * and enumeration is over half of what the cache exists to save. Ambient inputs
 * are the opposite case on both counts — they are **constant across the verbs
 * of one invocation and across a phase run**, so folding them separates nothing
 * that would otherwise share; and two runs that disagree on them genuinely
 * cannot share a filesystem extent, so they **must** be separated.
 *
 * ## The rule to apply when a third one appears
 *
 * Ask of every populate option: *would two runs differing only in this produce
 * different rows?* Every yes belongs here.
 *
 * ## 🔑 The third entry is DERIVED, which is why the list did not have to stop
 *
 * This paragraph used to say: if the list grows past two, stop extending it and
 * let each contributor declare its own ambient fingerprint instead — because
 * *"the list below is the set someone remembered to model, which is exactly the
 * property that failed the first time."* That warning is about **hand-maintained
 * enumeration**, and it still stands for anything spelled out here as a literal.
 *
 * `parseRouting` is not that. Its value is
 * {@link CollectionMimeResolver.fingerprint}, computed from the routing rules
 * themselves at the moment the routing is built — so it cannot fall behind them.
 * A new parser kind, a new declaration field, or a whole new routing rule
 * changes the fingerprint by being part of what is digested, with **no edit
 * here**. The entry is a pointer at a self-describing input rather than
 * somebody's recollection of one.
 *
 * That is the shape a fourth entry should take too. A fourth *literal* is still
 * the thing to refuse; a fourth input that can describe itself is not.
 *
 * Without it, declared types would be a textbook false hit: they appear in no
 * parameter set, so two runs over an unchanged tree that route differently share
 * a key and the second is served the first's `mime` columns, content keys and
 * blob rows, at exit 0.
 *
 * @param options - The run's options, for its ambient inputs
 * @param rootId - This run's corpus root id
 * @param cache - The caller's store and tree hash
 * @param routing - The run's parse routing, for its rule fingerprint
 * @returns The key to read and write under
 */
function storeKeyFor(
  options: PopulateOptions,
  rootId: string,
  cache: PopulationCache,
  routing: CollectionMimeResolver,
): ExtentKey {
  const ambient = canonicalJson({
    gitTracker: options.gitTracker !== undefined,
    extentSource: crawlSourceSelector() ?? null,
    parseRouting: routing.fingerprint,
    // A constant within one release, so this guards invalidation ACROSS releases: a realization
    // past the input cap is stored `oversize`, and rows a release derived under its cap answer no
    // run of a release with another.
    inputBytes: POPULATION_PARSE_LIMITS.inputBytes,
    registrations: registrationQuestions(options),
  });
  return { rootId, treeHash: `${cache.treeHash} ${ambient}` };
}

/**
 * What every registered contributor learned at CONSTRUCTION, sorted by id.
 *
 * The third ambient input, after the git oracle and the enumerator selector,
 * and the one that hides inside the contributors rather than around them — see
 * {@link ExtentContributor.registrationQuestion} for the failure that put it
 * here. Contributors declaring nothing are omitted entirely rather than
 * recorded as `null`, so registering one cannot move the key of a run whose
 * question it did not change.
 *
 * Keyed by contributor id rather than emitted as a list, so registration ORDER
 * cannot move the key: {@link canonicalJson} sorts object keys and preserves
 * array order, so an object is order-independent by the digest's own rule and a
 * list would have needed a sort here that no fixture could exercise while
 * exactly one contributor declares anything.
 *
 * @param options - The run, for its registry
 * @returns Every declared question, by contributor id; empty when none declares one
 */
function registrationQuestions(options: PopulateOptions): Record<string, JsonValue> {
  const declared: Record<string, JsonValue> = {};
  for (const contributor of [
    ...options.registry.byStratum('base'),
    ...options.registry.byStratum('closure'),
  ]) {
    if (contributor.registrationQuestion === undefined) continue;
    declared[contributor.id] = contributor.registrationQuestion;
  }
  return declared;
}

/**
 * Every contributor this run registered, paired with the parameters it will run
 * under — the run's question, as `zone_provenance` records it.
 *
 * Both strata, because a stored extent that holds the base but not the closure
 * answers only half of what was asked, and a half answer here is a projection
 * whose closure extents are each their own declared root.
 *
 * @param options - The run's registry and parameters
 * @returns One entry per registered contributor
 */
export function requestedContributors(options: PopulateOptions): readonly RequestedContributor[] {
  return [...options.registry.byStratum('base'), ...options.registry.byStratum('closure')]
    .map((contributor) => ({
      id: contributor.id,
      parameterSet: options.parameters?.[contributor.id] ?? null,
    }));
}

/**
 * Answer this population from the store, if the store holds an answer to this
 * exact question.
 *
 * Every way of not answering returns `undefined` and the run proceeds as if
 * there were no store — but a store that *throws* is not one of them. A cache is
 * recoverable by definition, so swallowing its errors is tempting; it is also
 * how a store that has been silently failing to write for a week goes unnoticed
 * while every run pays full price and reports success. The failure surfaces.
 *
 * @param options - The run's options, including its cache if it has one
 * @param rootId - This run's corpus root id
 * @param parseContent - Whether this run reads and parses content at all
 * @param routing - The run's parse routing, whose fingerprint is part of the key
 * @returns The hydrated projection, or the pairs it lacked on a miss — so a
 *   miss a refusal caused can be counted (ADR I10)
 */
async function readCachedProjection(
  options: PopulateOptions,
  rootId: string,
  parseContent: boolean,
  routing: CollectionMimeResolver,
): Promise<CachedRead> {
  const cache = options.cache;
  if (cache === undefined) return NOTHING_HELD;

  const extent = await readStoredExtent(
    options,
    rootId,
    routing,
    requestedContributors(options),
  );
  if (extent === undefined) return NOTHING_HELD;

  // A run that declined to derive the blob tier must also decline to read it
  // back, or a hit would hand it four tables a populate would have left empty
  // — and `'skip'` is a claim about what the caller reads, so honouring it on
  // both paths is what keeps hydrated and populated indistinguishable.
  if (!parseContent) return { hit: assembleProjection(extent, emptyBlobRows()) };

  const contentKeys = keyedContentKeys(extent);
  const blobs = await cache.store.readBlobFacts(contentKeys);
  // See `store-hydration.ts`: an extent written by a run that skipped blob
  // derivation names keys the blob tier does not hold, and accepting it would
  // reduce every closure extent to its own root while reporting success.
  const uncovered = uncoveredContentKeys(blobs, contentKeys);
  if (uncovered.length > 0) return { missed: uncovered };

  // The harness facts are derived lazily and stored per `(blob, harness)`, so
  // a blob tier that covers every key can still lack a reached blob's facts —
  // another root's run filed those bytes without reaching them. Served, that
  // absence would throw at the first strict reader; a miss re-derives it.
  const projection = assembleProjection(extent, blobs);
  const unsettled = harnessUnsettledKeys(projection, HARNESS_PROFILE_LIST);
  return unsettled.length === 0 ? { hit: projection } : { missed: unsettled };
}

/**
 * The extent half of a store hit: key, reuse rule, narrowing, staleness gate.
 *
 * Split out of {@link readCachedProjection} because one caller needs exactly
 * this and nothing after it — see {@link readStoredMembership} — and two
 * copies of the four steps is how one of them would lose the unlistable gate.
 * The blob tier is deliberately NOT here: it belongs to the run that reads blob
 * tables, and a caller asking only *which paths are in this tree* has no use
 * for it and should not pay a `readBlobFacts`.
 *
 * @param options - The run's options, including its cache
 * @param rootId - This run's corpus root id
 * @param routing - The run's parse routing, whose fingerprint is part of the key
 * @param requested - The contributors whose provenance the store must hold
 * @returns The stored rows narrowed to those contributors' contexts, or
 *   `undefined` on any kind of miss
 */
async function readStoredExtent(
  options: PopulateOptions,
  rootId: string,
  routing: CollectionMimeResolver,
  requested: readonly RequestedContributor[],
): Promise<ExtentScopedRows | undefined> {
  const cache = options.cache;
  if (cache === undefined) return undefined;

  const startedAt = crawlTimingStart();
  try {
    const stored = await cache.store.readExtent(storeKeyFor(options, rootId, cache, routing));
    if (stored === undefined) return undefined;

    const contexts = selectRequestedContexts(stored, requested);
    if (contexts === undefined) return undefined;

    const extent = selectRequestedRows(stored, { contexts, rootId });
    // A stored extent enumerated AROUND a directory it could not list is a hit
    // only while that directory still cannot be listed. The key cannot tell —
    // an ignored directory's mode bit is in no tree hash — so the rows say
    // what they claimed and the tree is asked whether it is still so. See
    // `unlistableRowStillHolds` for the staleness this closes.
    if (!unlistableRowsStillHold(extent.realizationConditions, options.root)) return undefined;
    // Same shape for a declined link: its row — code and message — is where
    // the HOST resolves it, through targets no tree hash covers (a gitignored
    // `build/gen.md`, an out-of-root hop), so a changed row is a miss. See
    // `declinedSymlinkRowsStillHold`.
    if (!declinedSymlinkRowsStillHold(extent.realizationConditions, extent.resourceRealizations, options.root)) {
      return undefined;
    }
    return extent;
  } finally {
    // Filed whether this hit or missed, and that is the point: a hit runs no
    // contributor, so without this row a dump cannot tell a served population
    // from a subject that exercised nothing. See {@link CRAWL_STORE_READ_ID}.
    recordCrawlPass(CRAWL_STORE_READ_ID, 'base', BASE_STRATUM_PASS, startedAt);
  }
}

/**
 * A tree's membership as the store holds it: the realization and condition rows
 * of the requested contributors' contexts, and the outcome that says the store
 * served them.
 */
export interface StoredMembership {
  readonly resourceRealizations: readonly ResourceRealizationRow[];
  readonly realizationConditions: readonly RealizationConditionRow[];
  /** Always the hit: this read mints it, because no `populate()` runs on this path. */
  readonly outcome: PopulationOutcome;
}

/**
 * What the store already knows this tree REALIZES, for a subset of the run's
 * contributors — without populating anything.
 *
 * ## Why a lane would ask this instead of populating
 *
 * Membership is a VIEW over the one population every resources lane shares:
 * `buildResourcePopulation` registers the full lane's contributors under the full
 * lane's key, and reads only realizations and conditions. So the extent alone
 * answers it, and the blob tier is not read: a stored extent whose blob key was
 * evicted is a membership hit and a full-lane miss.
 *
 * A lane whose contributor set is not known until something about the tree has
 * been read has to read the tree twice: once to find out what to register, and
 * once for real. `buildClaudeContextPopulation` is that lane — it needs every
 * `CLAUDE.md` and `.claude/rules` path before it can register one
 * `ClaudeImportExtentContributor` per root — and the discovery half cost a
 * measured **341.7 ms** of a 794.6 ms warm crawl on a 12.6k-file adopter, every
 * run, for a list the store was already holding. This answers it from the rows
 * instead.
 *
 * ## ⛔ The key is the CALLER'S, and that is a requirement, not a convenience
 *
 * `options` must be the **same object** the caller will hand {@link populate},
 * so both reads compute {@link storeKeyFor} from one registry and one parameter
 * map and cannot drift apart. A caller registering more contributors afterwards
 * (which is the whole point) changes the key only if one of them declares an
 * {@link ExtentContributor.registrationQuestion} — no `@`-import contributor does, and if one
 * ever did, this read would simply stop hitting and the caller would fall back
 * to deriving the list. Fail-safe in the direction that costs time rather than
 * correctness.
 *
 * ⚠️ **`requested` must be a subset the store can answer ALONE.** Asking for a
 * contributor the caller has not registered yet is not a hit it would otherwise
 * have got — it is a guarantee of a miss, because nothing has ever written that
 * provenance under this key.
 *
 * @param options - The options the caller will populate with, unmodified
 * @param requested - The already-known contributors whose contexts must be
 *   stored, each with the parameter set `options.parameters` gives it
 * @returns The realization and condition rows of exactly those contributors'
 *   contexts with the hit outcome, or `undefined` when the store cannot answer —
 *   in which case the caller populates
 */
export async function readStoredMembership(
  options: PopulateOptions,
  requested: readonly RequestedContributor[],
): Promise<StoredMembership | undefined> {
  if (options.cache === undefined) return undefined;

  // The two values `populate` derives before it asks the store, derived the same
  // way. The resolver is built and discarded here: only its `fingerprint` is
  // read, and the conflicts it would accumulate belong to the run's own
  // instance, which `populate` builds for itself.
  const routing = createCollectionMimeResolver(options.collections);
  const extent = await readStoredExtent(options, rootIdFor(options.root), routing, requested);
  if (extent === undefined) return undefined;
  return {
    resourceRealizations: extent.resourceRealizations,
    realizationConditions: extent.realizationConditions,
    outcome: populationOutcome('hit'),
  };
}

/**
 * Whether every stored `EXTENT_DIRECTORY_UNLISTABLE` row is still true of the
 * tree — the gate that turns a key match into a real hit.
 *
 * One of two such gates; the other is `declinedSymlinkRowsStillHold`, which
 * re-derives every declined-link row (any of the four `DECLINED_SYMLINK_CODES`)
 * and compares the WHOLE row — code, message and fault class — because both depend on targets
 * the tree hash does not cover — the message names the in-root path a link
 * resolves through, which an out-of-root hop can move under an unchanged code.
 * The remaining condition rows describe content the tree hash already covers. One probe per
 * stored refusal, not per path — so a tree with none pays one filter over the
 * conditions table and no syscall.
 *
 * @param conditions - The stored extent's `realization_conditions`
 * @param root - The corpus root the rows' paths are relative to
 * @returns True when the extent may be served
 */
function unlistableRowsStillHold(conditions: readonly RealizationConditionRow[], root: string): boolean {
  return conditions
    .filter((row) => row.code === EXTENT_DIRECTORY_UNLISTABLE)
    .every((row) => unlistableRowStillHolds(row, root));
}

/**
 * Record a freshly derived population in the store.
 *
 * Blob facts first, then the extent. The order is the recovery order: a reader
 * that finds the extent must find the facts its realizations name, and writing
 * the extent first opens a window in which a concurrent reader hits the extent,
 * fails the coverage check, and re-derives a corpus that was moments from being
 * complete.
 *
 * `writeBlobFacts` is skipped rather than called with four empty tables when the
 * run derived none — the call would be a no-op, but skipping it keeps "this run
 * had nothing to say about blobs" distinguishable from "it said there are none"
 * in anything that watches the store.
 *
 * @param options - The run's options, including its cache if it has one
 * @param rootId - This run's corpus root id
 * @param parseContent - Whether this run read and parsed content
 * @param projection - What the run produced
 * @param routing - The run's parse routing, whose fingerprint is part of the key
 * @returns What happened to the extent — the miss half of {@link PopulationOutcome.stored}
 */
async function writeCachedProjection(
  options: PopulateOptions,
  rootId: string,
  parseContent: boolean,
  projection: Projection,
  routing: CollectionMimeResolver,
): Promise<Exclude<PopulationOutcome['stored'], 'hit'>> {
  const cache = options.cache;
  if (cache === undefined) return 'no-store';

  const startedAt = crawlTimingStart();
  const { blobs, extent } = splitProjectionByScope(projection);
  // Blob facts are keyed by the bytes actually read, so they are true whatever
  // the tree did meanwhile. The extent is keyed by the tree, so it is not.
  if (parseContent) await cache.store.writeBlobFacts(storableBlobFacts(blobs));
  const unchanged = cache.treeUnchanged();
  if (unchanged) {
    await cache.store.writeExtent(storeKeyFor(options, rootId, cache, routing), extent);
  }
  recordCrawlPass(CRAWL_STORE_WRITE_ID, 'base', BASE_STRATUM_PASS, startedAt);
  return unchanged ? 'written' : 'skipped-tree-changed';
}

/**
 * Whether this run reads and parses content, refusing an unsound request.
 *
 * The refusal is the load-bearing half. `'skip'` is a claim the caller makes
 * about ITS OWN reads, and it cannot speak for the contributors it registered —
 * `ClosureExtentContributor`'s edges *are* `blob_references` rows, so a closure
 * extent under a skipped stage is its declared root and nothing else while
 * `populate()` reports success. That is the precise failure `blob-population.ts`
 * was written to prevent, so it is an error here rather than a degraded result,
 * for the same reason `ContributorRegistry.forKind` throws instead of returning
 * an empty array.
 *
 * The message names the contributors, because the request and the obstacle are
 * usually in different files: a caller adds a closure extent months after
 * something else asked to skip.
 *
 * @param options - The run's options and registry
 * @returns True when the stage should run
 * @throws When `'skip'` is asked for while a registered contributor reads blobs
 */
function contentParsingFor(options: PopulateOptions): boolean {
  if ((options.contentParsing ?? CONTENT_PARSING_DERIVE) === CONTENT_PARSING_DERIVE) return true;

  const readers = options.registry.blobReaders();
  if (readers.length > 0) {
    throw new Error(
      `populate() was asked to skip content parsing, but ${readers.length} registered contributor(s) read the blob-keyed tables: ${readers.map((contributor) => contributor.id).join(', ')}.`
      + ' Their extents would be silently reduced to their declared roots and the run would still report success,'
      + ` so this is refused. Either drop the "${CONTENT_PARSING_SKIP}" request or unregister those contributors.`,
    );
  }
  return false;
}

/**
 * Run the between-strata blob stage, charged to the projection arm.
 *
 * Its own function so the crawl-timing bracket cannot be separated from the call
 * it brackets by a later edit — the stage reads and parses every path the base
 * contributors keyed, which is the projection's analogue of the incumbent's
 * `resource-registry:admit`, and that one IS charged. Leaving it out
 * biased the one comparison the seam exists to support, and only on one side;
 * see `CRAWL_BLOB_POPULATE_ID`.
 *
 * @param builder - The builder to derive into
 * @param dispatcher - The run's dispatcher
 */
async function runBlobStage(builder: ProjectionBuilder, dispatcher: ParseDispatcher): Promise<void> {
  const startedAt = crawlTimingStart();
  await populateBlobs(builder, { dispatcher });
  recordCrawlPass(CRAWL_BLOB_POPULATE_ID, 'base', BASE_STRATUM_PASS, startedAt);
}

/**
 * Derive the blobs a demand promotion during the closure stratum made available,
 * if any.
 *
 * ## Why a second run of the stage exists at all
 *
 * `FilesystemExtentContributor` defers gitignored paths, so their realizations
 * arrive `contentState: 'deferred'` with no key and the first
 * {@link populateBlobs} correctly derives no blob for them. Anything that then
 * calls `ProjectionBuilder.ensureContentKey` — a closure declaration reaching
 * into an ignored tree, a lens asking for bytes — turns those rows `keyed`,
 * and without this the projection would carry a realization naming a blob that
 * has no `blobs` row and no `blob_references`: a dangling foreign key, and
 * precisely the silent-emptiness failure the stage was written to prevent.
 *
 * **Nothing shipped promotes yet.** `ProjectionBase` is the read-only view a
 * contributor is handed and it exposes no mutator, so as of this commit no
 * contributor *can* call `ensureContentKey` and `builder.contentPromotionAttempts`
 * is always unchanged here. That is deliberate — the demand consumer is the next
 * piece of work, and landing the driver blind to it would mean the first
 * consumer silently produced dangling blob keys. The unit test below therefore
 * drives this function directly rather than through {@link populate}, because a
 * `populate()`-level test could not distinguish "correct" from "never ran".
 *
 * ## Why it is strictly after the fixpoint, and why that is safe
 *
 * `ClosureExtentContributor` memoizes a whole-corpus `blob_references` index
 * per run (`referencesByBlobFor`, a `WeakMap` on the base — it cut 122 index
 * rebuilds to 1). Its soundness rests on blobs being derived exactly once
 * *between* the strata, so that no closure pass can observe the index changing
 * under it. Running the stage here preserves that argument twice over:
 *
 * 1. Nothing reads the index after the fixpoint has converged, so a
 *    `blob_references` row added now is observed by no closure contributor.
 * 2. The memo key includes `base.blobReferences.length`, not just the base's
 *    identity, so even a hypothetical later reader would be handed a rebuilt
 *    index rather than the stale one.
 *
 * A future change that moves this call *inside* the loop invalidates both, and
 * would have to invalidate the memo explicitly instead.
 *
 * ## The gate is on attempts
 *
 * {@link ProjectionBuilder.contentPromotionAttempts} moves whenever bytes were
 * demanded, whatever the read did. When every attempt failed the stage still
 * runs: one cheap walk that derives nothing, over rows now `unreadable`, whose
 * cause is on the `REALIZATION_PROMOTION_UNREADABLE` rows the failed attempts
 * recorded.
 *
 * Exported for the focused unit test — driving it through {@link populate}
 * would mean walking a real tree to reach a decision that is a comparison of
 * two integers. {@link populate} is its only production caller.
 *
 * @param builder - The builder whose closure stratum has just converged
 * @param attemptsBefore - `contentPromotionAttempts` as it stood before the stratum
 * @param dispatcher - The run's dispatcher, which the blob stage parsed on
 */
export async function afterClosurePromotion(
  builder: ProjectionBuilder,
  attemptsBefore: number,
  dispatcher: ParseDispatcher,
): Promise<void> {
  if (builder.contentPromotionAttempts === attemptsBefore) {
    return;
  }
  // Idempotent by construction: `blobsAlreadyPresent` skips every blob the
  // first run derived, so only the newly keyed paths cost a parse.
  //
  // Files the SAME row as the pre-closure run — one accounting unit, so `calls`
  // reads as "how many times the stage ran" and its ms/call stays divisible.
  const startedAt = crawlTimingStart();
  await populateBlobs(builder, { dispatcher });
  recordCrawlPass(CRAWL_BLOB_POPULATE_ID, 'base', BASE_STRATUM_PASS, startedAt);
}

/** Every harness a population derives facts for. */
const HARNESS_PROFILE_LIST: readonly HarnessProfile[] = Object.values(HARNESS_PROFILES);

/**
 * The pseudo contributor id {@link ClosureNonConvergenceError} names when the
 * harness pass is what kept the fixpoint moving.
 */
const HARNESS_PASS_ID = 'harness-pass';

/** One population's harness pass, bound to its builder and reader. */
interface HarnessStage {
  /** Run the pass to exhaustion; resolves to the facts rows it added. */
  run(): Promise<number>;
  /** Throw `HarnessFactsAbsentError` for a reached blob with no facts, excusing only what a pass could not read. */
  assertSettled(): void;
}

/**
 * Bind the harness pass to one population: every harness, the run's content
 * cache as the reader, the run's dispatcher as what reads it, and the keys any
 * pass could not read.
 *
 * @param builder - The population's builder
 * @param dispatcher - The run's dispatcher
 * @returns The stage
 */
function harnessStageFor(builder: ProjectionBuilder, dispatcher: ParseDispatcher): HarnessStage {
  const reader = diskHarnessContentReader(builder.base().contentCache);
  const derive = dispatcherHarnessFacts(dispatcher);
  const unreadable = new Set<string>();
  return {
    run: async () => {
      const result = await runHarnessPass(builder, HARNESS_PROFILE_LIST, reader, derive);
      for (const key of result.unreadableKeys) unreadable.add(key);
      return result.derived;
    },
    assertSettled: () => {
      assertHarnessSettled(builder.base(), HARNESS_PROFILE_LIST, unreadable);
    },
  };
}

/**
 * Iterate the closure stratum to a fixed point.
 *
 * The harness pass runs after every iteration's contributors and counts as
 * moving when it derives anything: the closure contributors read harness facts
 * in `frontier` mode, so a member whose facts arrive now is followed only on
 * the next iteration.
 *
 * @param closure - The closure contributors, possibly empty
 * @param builder - The builder every contribution merges into
 * @param parameterSetFor - Resolves a contributor's parameter set
 * @param maxIterations - Passes allowed before failing
 * @param harness - The population's harness pass
 * @param onTiming - Receives one record per contributor invocation, per pass
 * @throws {@link ClosureNonConvergenceError} when the cap is reached while moving
 * @throws {@link RangeError} when the cap is below one, which could only ever fail
 */
async function iterateClosure(
  closure: readonly ExtentContributor[],
  builder: ProjectionBuilder,
  parameterSetFor: (contributor: ExtentContributor) => JsonValue,
  maxIterations: number,
  harness: HarnessStage,
  onTiming?: ((timing: ContributorTiming) => void) | undefined,
): Promise<void> {
  // Ordinary and cheap, unlike a kind with no contributor: a corpus whose
  // configuration declares no closure-defined extents has nothing to iterate.
  // The harness pass needs no iteration then — `populate` ran it before this.
  if (closure.length === 0) {
    return;
  }
  if (maxIterations < 1) {
    throw new RangeError(
      `maxIterations must be at least 1; received ${maxIterations}.`
      + ' A cap below one cannot observe convergence and could only ever fail.',
    );
  }

  const previousDigests = new Map<string, string>();

  // One pass at a time: each reads the rows the previous pass merged.
  const pass = async (iteration: number): Promise<void> => {
    const moving: string[] = [];
    // Sequential for the same reason as the base loop above.
    await forEachInOrder(closure, async (contributor) => {
      const startedAt = performance.now();
      // Same attribution wrapper as the base loop — see the comment there.
      const digest = await withContributorStratum('closure', () =>
        runContributor(contributor, builder, parameterSetFor(contributor)),
      );
      reportContributorTiming(onTiming, {
        contributorId: contributor.id,
        stratum: 'closure',
        pass: iteration,
        elapsedMs: performance.now() - startedAt,
      });
      // Per-contributor comparison, not whole-projection: a whole-projection
      // digest would also move when a base row arrived, and cannot name which
      // contributor is responsible when it fails to settle.
      if (previousDigests.get(contributor.id) !== digest) {
        previousDigests.set(contributor.id, digest);
        moving.push(contributor.id);
      }
    });
    if (await harness.run() > 0) moving.push(HARNESS_PASS_ID);
    if (moving.length === 0) {
      return;
    }
    if (iteration >= maxIterations) {
      throw new ClosureNonConvergenceError(moving, maxIterations);
    }
    return pass(iteration + 1);
  };
  await pass(1);
}

/**
 * Invoke one contributor, merge its rows, and record its provenance.
 *
 * The single `parameterSet` binding is handed to `contribute` and written to
 * `zone_provenance.parameterSet` — one value used twice, so the row cannot
 * describe a parameter set the contributor did not actually run under.
 *
 * One provenance row is written **per context the contribution declares**,
 * carrying the digest of the whole contribution. A contributor declaring several
 * extents at once — the package extent declares one per package — therefore
 * attributes the same digest to each, which is the honest reading of a digest
 * whose domain is one invocation.
 *
 * @param contributor - The contributor to invoke
 * @param builder - The builder to merge into
 * @param parameterSet - This run's parameters, recorded verbatim
 * @returns The contribution's digest, the fixpoint's convergence oracle
 */
async function runContributor(
  contributor: ExtentContributor,
  builder: ProjectionBuilder,
  parameterSet: JsonValue,
): Promise<string> {
  const contribution = await contributor.contribute(builder.base(), parameterSet);
  const digest = extentDigest(contribution);
  mergeContribution(builder, contribution);

  for (const context of contribution.contexts) {
    builder.addProvenance({
      contextId: context.contextId,
      contributorId: contributor.id,
      parameterSet,
      extentDigest: digest,
    });
  }

  return digest;
}

/**
 * Merge one contribution's rows into the builder.
 *
 * Every `add*` return value is deliberately discarded: the builder's
 * de-duplication *is* the merge rule, and a closure contributor re-emitting the
 * rows it emitted last pass must be a no-op rather than a reported conflict —
 * otherwise the condition table would grow every pass and the digest would never
 * settle.
 *
 * @param builder - The builder to merge into
 * @param contribution - The rows to merge
 */
function mergeContribution(builder: ProjectionBuilder, contribution: ExtentContribution): void {
  for (const row of contribution.contexts) {
    builder.addContext(row);
  }
  for (const row of contribution.resources) {
    builder.addResource(row);
  }
  for (const row of contribution.realizations) {
    builder.addRealization(row);
  }
  for (const row of contribution.memberships) {
    builder.addExtentMembership(row);
  }
  for (const row of contribution.tags) {
    builder.addTag(row);
  }
  for (const row of contribution.conditions) {
    builder.addCondition(row);
  }
  for (const row of contribution.claudeRulePatterns) {
    builder.addClaudeRulePattern(row);
  }
}
