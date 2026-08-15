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

import { CRAWL_BLOB_POPULATE_ID, crawlTimingStart, recordContributorInvocation, recordCrawlPass, safePath, withContributorStratum, type GitTracker } from '@vibe-agent-toolkit/utils';

import type { JsonValue } from '../schemas/projection-shared.js';

import { populateBlobs, type BlobPopulationResult } from './blob-population.js';
import { RunContentCache } from './content-cache.js';
import type { ContributorRegistry, ExtentContribution, ExtentContributor } from './contributor.js';
import { extentDigest } from './digest.js';
import { ProjectionBuilder, type Projection } from './projection.js';

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
   * The post-fixpoint run, present only when the closure stratum promoted at
   * least one `deferred` realization to `keyed`.
   *
   * Absent — not a zeroed result — when no promotion happened, because "the
   * stage did not need to run again" and "it ran again and derived nothing" are
   * different facts and a zeroed object cannot tell them apart.
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
   * Receives what the blob-derivation stage derived and what it skipped.
   *
   * An observation seam rather than a return value, because the counts are not
   * part of the projection: they describe the *run*, and a projection is rows.
   * They are nonetheless the only place two facts are observable — how many
   * headings and references were dropped for want of a source line, both of
   * which are asserted at zero on a real corpus, and neither of which any row
   * can carry (a row that was skipped is, definitionally, absent).
   *
   * Called **once**, after the closure fixpoint, so the record can carry both
   * runs of the stage — see {@link BlobPopulationReport}.
   */
  onBlobPopulation?: ((result: BlobPopulationReport) => void) | undefined;
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
  // Constructed here and nowhere else, so its lifetime is exactly this run's.
  // A module-level cache would leak bytes across two populations in one process
  // — including two populations of a tree that changed in between, which would
  // describe the wrong corpus with complete confidence.
  const builder = new ProjectionBuilder(root, options.gitTracker, new RunContentCache());

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
  // The stage is awaited into a binding *before* the optional call, never
  // inlined as `options.onBlobPopulation?.(await populateBlobs(builder))`:
  // optional chaining short-circuits the whole call expression, arguments
  // included, so the inlined form derives no blobs at all whenever no observer
  // is supplied — which is every caller that is not a test. Measured, not
  // feared: it is how this stage first shipped as a no-op. The post-fixpoint run
  // below is awaited into its own binding for exactly the same reason: an
  // `await` inside the optional call's argument list would be short-circuited
  // away, so the promoted blobs would be derived only when someone was watching.
  // Charged to the projection arm. This stage reads and parses every path the
  // base contributors keyed — the projection's analogue of the incumbent's
  // `resource-registry:add-resource`, which IS charged. Leaving it out biased the
  // one comparison the seam exists to support, and only on one side; see
  // `CRAWL_BLOB_POPULATE_ID`.
  const blobStartedAt = crawlTimingStart();
  const blobPopulation = await populateBlobs(builder);
  recordCrawlPass(CRAWL_BLOB_POPULATE_ID, 'base', BASE_STRATUM_PASS, blobStartedAt);
  const promotionsBeforeClosure = builder.contentPromotions;

  await iterateClosure(
    registry.byStratum('closure'),
    builder,
    parameterSetFor,
    maxIterations,
    options.onContributorTiming,
  );

  const promoted = await afterClosurePromotion(builder, promotionsBeforeClosure);
  options.onBlobPopulation?.({ ...blobPopulation, ...promoted });

  return builder.build();
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
 * contributor *can* call `ensureContentKey` and `builder.contentPromotions` is
 * always unchanged here. That is deliberate — the demand consumer is the next
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
 * Exported for the focused unit test that pins the two-run reporting rule —
 * driving it through {@link populate} would mean walking a real tree to reach a
 * decision that is a comparison of two integers. {@link populate} is its only
 * production caller.
 *
 * @param builder - The builder whose closure stratum has just converged
 * @param promotionsBefore - `contentPromotions` as it stood before the stratum
 * @returns A one-key object to spread onto the report, empty when nothing was
 *   promoted — an absent key, never a zeroed result, because `exactOptionalPropertyTypes`
 *   makes those two different values and they mean different things
 */
export async function afterClosurePromotion(
  builder: ProjectionBuilder,
  promotionsBefore: number,
): Promise<{ afterClosurePromotion?: BlobPopulationResult }> {
  if (builder.contentPromotions === promotionsBefore) {
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
