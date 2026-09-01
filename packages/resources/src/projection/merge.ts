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
 *    `blobs` rows their realizations now name. Strictly after the fixpoint, and
 *    reported as a separate measurement: see {@link BlobPopulationReport}.
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
  recordContributorInvocation,
  recordCrawlPass,
  safePath,
  withContributorStratum,
} from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { CollectionConfig } from '../schemas/project-config.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';
import type { JsonValue } from '../schemas/projection-shared.js';

import { populateBlobs, type BlobPopulationResult } from './blob-population.js';
import { RunContentCache } from './content-cache.js';
import type { ContributorRegistry, ExtentContribution, ExtentContributor } from './contributor.js';
import { crawlSourceSelector } from './crawl-source.js';
import { canonicalJson, extentDigest } from './digest.js';
import { rootIdFor } from './identity.js';
import { ProjectionBuilder, type Projection } from './projection.js';
import {
  collectionMimeConflictCondition,
  createCollectionMimeResolver,
  type CollectionMimeResolver,
} from './realizations.js';
import {
  assembleProjection,
  blobFactsCover,
  emptyBlobRows,
  keyedContentKeys,
  selectRequestedContexts,
  selectRequestedRows,
  type RequestedContributor,
} from './store-hydration.js';
import { splitProjectionByScope, type ExtentKey, type ProjectionStore } from './store.js';

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
 * **Measured 2026-08-13, and this number is four times the measurement.** A
 * whole-corpus population of the vibe-agent-toolkit repository with all six
 * shipped contributors registered — 61 skill extents, plus plugin and
 * marketplace, 66 contributors in total — reached its fixed point on **pass 2**:
 * one productive pass, then one confirming pass in which no digest moved. No
 * contributor needed a third. (`projection-population.integration.test.ts`,
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

/**
 * The {@link PopulateOptions.onBlobPopulation} observer that keeps nothing — the
 * explicit spelling of "this run does not want the blob stage's counts".
 *
 * Naming it is the point, exactly as it is for `NO_GIT_TRACKER`. The counts
 * record what the stage REFUSED to derive, and while the option was optional
 * every production run discarded them by accident. A run that discards them on
 * purpose — one that skips the stage outright, or a test asserting something
 * else entirely — now says so at the call site.
 *
 * ⚠️ Not a licence to reach for this on a lane that derives blobs. If the stage
 * runs and its refusals go nowhere, the corpus can be entirely undeliverable and
 * the command still exits 0 saying nothing.
 */
export const DISCARD_BLOB_POPULATION: (result: BlobPopulationReport) => void = () => {
  // Intentionally empty — see the docstring. The whole value of this constant is
  // that it appears at a call site.
};

/**
 * What the blob-derivation stage did across a whole `populate()` — one run
 * between the strata, and optionally a second after the closure fixpoint.
 *
 * ## Why the second run is a separate object and not added to the first
 *
 * There is no honest arithmetic between two runs of {@link populateBlobs}.
 * `blobsAlreadyPresent` on the second pass counts nearly every blob the first
 * pass derived, so summing it reports a corpus several times its own size;
 * taking the later value instead misreports the first pass as having found
 * nothing already present. The same objection applies to every
 * `realizationsSkipped*` bucket: the second pass walks the same realizations,
 * so adding them double-counts every directory in the corpus.
 *
 * The two runs are therefore two measurements of two different builder states,
 * and they are reported as two measurements. A consumer that genuinely wants a
 * total for one bucket knows which buckets are additive; this type declines to
 * guess on its behalf.
 */
export interface BlobPopulationReport extends BlobPopulationResult {
  /**
   * The post-fixpoint run, present whenever the closure stratum **attempted** at
   * least one demand promotion — whether or not the read succeeded.
   *
   * Absent — not a zeroed result — when nobody asked, because "the stage did not
   * need to run again" and "it ran again and derived nothing" are different
   * facts and a zeroed object cannot tell them apart.
   *
   * ⚠️ Attempted, not succeeded, and the distinction is the whole point: gating
   * on the success counter made "every promotion's read threw" produce the same
   * absent key as "no consumer asked", which is the one pair of outcomes this
   * key exists to separate. A run where every attempt failed is present here
   * with `blobsDerived: 0`.
   */
  readonly afterClosurePromotion?: BlobPopulationResult | undefined;
}

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
   * — 90% — deriving rows `buildResourcePopulation` never looks at. The walker
   * arm of the same command is 1,363 ms. Skipping it puts the projection lane at
   * ~1.5× the walk instead of 5.6×.
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
   * Receives what the blob-derivation stage derived and what it skipped.
   *
   * An observation seam rather than a return value, because the counts are not
   * part of the projection: they describe the *run*, and a projection is rows.
   * They are nonetheless the only place two facts are observable — how many
   * headings and references were dropped for want of a source line, neither of
   * which any row can carry (a row that was skipped is, definitionally, absent).
   *
   * Called **once**, after the closure fixpoint, so the record can carry both
   * runs of the stage — see {@link BlobPopulationReport}.
   *
   * ## REQUIRED, and that is the fix rather than a style choice
   *
   * It was optional, and the consequence was not hypothetical. Of the two
   * production callers of `populate()`, one skips the stage entirely and the
   * other — `buildInventoryPopulation` — ran it and passed no observer, so every
   * `blobsNotText`, `blobsUnreadable`, `blobsParseFailed` and
   * `referencesSkippedForMissingLine` this stage computed was discarded at the
   * end of the run. `looksBinary` documents itself as "a refusal, not a silence"
   * and `blobsNotText` as "what makes the refusal auditable rather than a quiet
   * speed-up"; both claims were false in every shipped run. A corpus in which
   * every document was declined as binary produced an empty `blobs` table, exit
   * 0, and no output.
   *
   * The same reasoning `NO_GIT_TRACKER` is built on applies here and reaches the
   * same shape: a caller that genuinely wants the counts thrown away says
   * {@link DISCARD_BLOB_POPULATION} out loud, in a form that greps, rather than
   * arriving in that state by leaving an argument off. An omission is now a type
   * error; a discard is a decision with a name.
   */
  onBlobPopulation: (result: BlobPopulationReport) => void;
  /**
   * Receives one record per contributor invocation, as it completes.
   *
   * The same kind of observation seam as {@link onBlobPopulation}, and it exists
   * for the same reason that one does: the cost of a run is a fact about the
   * *run*, and a projection is rows, so there is nowhere in the returned tables
   * to put it.
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
   * **Optional, and the seam does not depend on it.** Every record is also filed
   * with `crawl-timing.ts`, which dumps them when `VAT_CRAWL_TIMING` is set —
   * see {@link reportContributorTiming}. This option existed for two years' worth
   * of commits with no observer anywhere in the repository (three grep hits, all
   * inside this file), which meant both brackets below could have been deleted
   * with nothing failing. A caller that wants the records in-process still gets
   * them here; a caller that wants them on disk needs no caller at all.
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
export class ClosureNonConvergenceError extends Error {
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
      `The closure stratum did not converge after ${iterations} pass(es) over it.`
      + ` Still moving: ${moving}.`
      + ' Returning the extent reached so far would report a truncated extent as a complete one,'
      + ' so this is an error rather than a capped result.',
    );
    this.name = 'ClosureNonConvergenceError';
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
 * @returns The frozen projection every registered contributor agreed on
 * @throws {@link ClosureNonConvergenceError} when the closure stratum is still
 *   moving after `maxIterations` passes
 * @throws Whatever a contributor throws — failures propagate unwrapped
 */
export async function populate(options: PopulateOptions): Promise<Projection> {
  const { root, registry, parameters, maxIterations = DEFAULT_MAX_ITERATIONS } = options;

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
  if (cached !== undefined) {
    return cached;
  }

  // Constructed here and nowhere else, so its lifetime is exactly this run's.
  // A module-level cache would leak bytes across two populations in one process
  // — including two populations of a tree that changed in between, which would
  // describe the wrong corpus with complete confidence.
  const builder = new ProjectionBuilder({
    root,
    gitTracker: options.gitTracker,
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

  for (const contributor of registry.byStratum('base')) {
    // Sequential on purpose: each contributor reads the base the previous ones
    // grew, and `ResourceIdentityMap` is a shared memo rather than a pure
    // function. Fanning these out with `Promise.all` would make the row set
    // depend on scheduling.
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
  }

  // Between the strata. The base is what records `contentKey` columns; the
  // closure stratum is what reads `blob_references`. A closure contributor only
  // ever re-realizes a path the base already realized, so the *only* way a new
  // content key can appear after this is an explicit demand promotion — which
  // `afterClosurePromotion` below picks up, after the fixpoint.
  //
  // The stage is awaited into a binding *before* the call, never inlined into
  // the observer's argument list. The hazard that rule was written for was
  // optional chaining — `options.onBlobPopulation?.(await populateBlobs(builder))`
  // short-circuits the whole call expression, arguments included, so the inlined
  // form derived no blobs at all whenever no observer was supplied, which was
  // every caller that was not a test. Measured, not feared: it is how this stage
  // first shipped as a no-op.
  //
  // `onBlobPopulation` is now REQUIRED, so that exact short-circuit is gone —
  // but the separation stays, because it is what keeps the stage's execution
  // independent of what any observer does with the result. A future edit that
  // reintroduces a `?.` here must not also be able to un-derive the corpus.
  //
  // `null` rather than a skipped-flag beside a zeroed result, so that every
  // consumer of the stage's outcome below is forced to handle the "did not run"
  // case rather than reading zeros as measurements.
  const blobPopulation = parseContent ? await runBlobStage(builder) : null;
  // ATTEMPTS, not successes — see {@link afterClosurePromotion} for why reading
  // the success counter here made a total promotion failure indistinguishable
  // from nobody having asked.
  const attemptsBeforeClosure = builder.contentPromotionAttempts;

  await iterateClosure(
    registry.byStratum('closure'),
    builder,
    parameterSetFor,
    maxIterations,
    options.onContributorTiming,
  );

  if (blobPopulation !== null) {
    const promoted = await afterClosurePromotion(builder, attemptsBeforeClosure);
    // Not called at all under `'skip'`, rather than called with a zeroed result:
    // "the stage did not run" and "it ran and derived nothing" are different
    // facts, and a zeroed report cannot tell them apart — the same rule
    // {@link BlobPopulationReport.afterClosurePromotion} states for its own
    // absence.
    options.onBlobPopulation({ ...blobPopulation, ...promoted });
  }

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

  const projection = builder.build();
  await writeCachedProjection(options, rootId, parseContent, projection, routing);
  return projection;
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
function requestedContributors(options: PopulateOptions): readonly RequestedContributor[] {
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
 * @returns The hydrated projection, or `undefined` on any kind of miss
 */
async function readCachedProjection(
  options: PopulateOptions,
  rootId: string,
  parseContent: boolean,
  routing: CollectionMimeResolver,
): Promise<Projection | undefined> {
  const cache = options.cache;
  if (cache === undefined) return undefined;

  const startedAt = crawlTimingStart();
  try {
    const stored = await cache.store.readExtent(storeKeyFor(options, rootId, cache, routing));
    if (stored === undefined) return undefined;

    const contexts = selectRequestedContexts(stored, requestedContributors(options));
    if (contexts === undefined) return undefined;

    const extent = selectRequestedRows(stored, { contexts, rootId });
    // A run that declined to derive the blob tier must also decline to read it
    // back, or a hit would hand it four tables a populate would have left empty
    // — and `'skip'` is a claim about what the caller reads, so honouring it on
    // both paths is what keeps hydrated and populated indistinguishable.
    if (!parseContent) return assembleProjection(extent, emptyBlobRows());

    const contentKeys = keyedContentKeys(extent);
    const blobs = await cache.store.readBlobFacts(contentKeys);
    // See `store-hydration.ts`: an extent written by a run that skipped blob
    // derivation names keys the blob tier does not hold, and accepting it would
    // reduce every closure extent to its own root while reporting success.
    if (!blobFactsCover(blobs, contentKeys)) return undefined;

    return assembleProjection(extent, blobs);
  } finally {
    // Filed whether this hit or missed, and that is the point: a hit runs no
    // contributor, so without this row a dump cannot tell a served population
    // from a subject that exercised nothing. See {@link CRAWL_STORE_READ_ID}.
    recordCrawlPass(CRAWL_STORE_READ_ID, 'base', BASE_STRATUM_PASS, startedAt);
  }
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
 */
async function writeCachedProjection(
  options: PopulateOptions,
  rootId: string,
  parseContent: boolean,
  projection: Projection,
  routing: CollectionMimeResolver,
): Promise<void> {
  const cache = options.cache;
  if (cache === undefined) return;

  const startedAt = crawlTimingStart();
  const { blobs, extent } = splitProjectionByScope(projection);
  if (parseContent) await cache.store.writeBlobFacts(blobs);
  await cache.store.writeExtent(storeKeyFor(options, rootId, cache, routing), extent);
  recordCrawlPass(CRAWL_STORE_WRITE_ID, 'base', BASE_STRATUM_PASS, startedAt);
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
 * @returns What the stage derived and what it skipped
 */
async function runBlobStage(builder: ProjectionBuilder): Promise<BlobPopulationResult> {
  const startedAt = crawlTimingStart();
  const result = await populateBlobs(builder);
  recordCrawlPass(CRAWL_BLOB_POPULATE_ID, 'base', BASE_STRATUM_PASS, startedAt);
  return result;
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
 * ## The gate is on ATTEMPTS, not on successes
 *
 * It used to be `builder.contentPromotions === promotionsBefore`, which is a
 * read of the SUCCESS counter — and `ProjectionBuilder.ensureContentKey` leaves
 * that counter untouched when the read throws. So a closure stratum that
 * demanded a thousand paths and could not read one of them produced the identical
 * `{}` this function returns when nobody asked at all, and the deliberate no-op
 * and a total failure were reported as the same thing.
 *
 * {@link ProjectionBuilder.contentPromotionAttempts} moves whenever bytes were
 * demanded, whatever the read did, so an absent `afterClosurePromotion` now means
 * exactly "no consumer asked" and nothing else. When every attempt failed the
 * stage still runs and reports `blobsDerived: 0` over rows that are now
 * `unreadable` — one cheap walk, no parses, and a measurement instead of a
 * silence. The per-path cause is on the `REALIZATION_PROMOTION_UNREADABLE` rows
 * the failed attempts recorded.
 *
 * Exported for the focused unit test that pins the two-run reporting rule —
 * driving it through {@link populate} would mean walking a real tree to reach a
 * decision that is a comparison of two integers. {@link populate} is its only
 * production caller.
 *
 * @param builder - The builder whose closure stratum has just converged
 * @param attemptsBefore - `contentPromotionAttempts` as it stood before the stratum
 * @returns A one-key object to spread onto the report, empty when nothing was
 *   even attempted — an absent key, never a zeroed result, because `exactOptionalPropertyTypes`
 *   makes those two different values and they mean different things
 */
export async function afterClosurePromotion(
  builder: ProjectionBuilder,
  attemptsBefore: number,
): Promise<{ afterClosurePromotion?: BlobPopulationResult }> {
  if (builder.contentPromotionAttempts === attemptsBefore) {
    return {};
  }
  // Idempotent by construction: `blobsAlreadyPresent` skips every blob the
  // first run derived, so only the newly keyed paths cost a parse.
  //
  // Files the SAME row as the pre-closure run — one accounting unit, so `calls`
  // reads as "how many times the stage ran" and its ms/call stays divisible.
  const startedAt = crawlTimingStart();
  const result = await populateBlobs(builder);
  recordCrawlPass(CRAWL_BLOB_POPULATE_ID, 'base', BASE_STRATUM_PASS, startedAt);
  return { afterClosurePromotion: result };
}

/**
 * Iterate the closure stratum to a fixed point.
 *
 * @param closure - The closure contributors, possibly empty
 * @param builder - The builder every contribution merges into
 * @param parameterSetFor - Resolves a contributor's parameter set
 * @param maxIterations - Passes allowed before failing
 * @param onTiming - Receives one record per contributor invocation, per pass
 * @throws {@link ClosureNonConvergenceError} when the cap is reached while moving
 * @throws {@link RangeError} when the cap is below one, which could only ever fail
 */
async function iterateClosure(
  closure: readonly ExtentContributor[],
  builder: ProjectionBuilder,
  parameterSetFor: (contributor: ExtentContributor) => JsonValue,
  maxIterations: number,
  onTiming?: ((timing: ContributorTiming) => void) | undefined,
): Promise<void> {
  // Ordinary and cheap, unlike a kind with no contributor: a corpus whose
  // configuration declares no closure-defined extents has nothing to iterate.
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
  let moving: string[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    moving = [];
    for (const contributor of closure) {
      // Sequential for the same reason as the base loop above.
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
    }
    if (moving.length === 0) {
      return;
    }
  }

  throw new ClosureNonConvergenceError(moving, maxIterations);
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
}
