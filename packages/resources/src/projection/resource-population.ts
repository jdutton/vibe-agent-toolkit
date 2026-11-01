/**
 * The **resource population**: the file list `vat resources scan`/`validate`
 * work from, answered by a projection instead of by `crawlDirectory`.
 *
 * This is the second production caller of `populate()` and the first outside
 * `vat inventory`. It is the lane sequenced ahead of the git-lane work, for
 * a reason worth restating where the code is: **validation is the only lane
 * where a wrong membership answer becomes an adopter-facing finding.**
 * `vat inventory` prints YAML nobody diffs; `vat resources validate` emits
 * `LINK_BROKEN_FILE` *at* someone. So this is where the projection's membership
 * answer is actually falsifiable.
 *
 * ## What changes, and why it is a fix rather than a regression
 *
 * `crawlDirectory` defaults to `respectGitignore: true, includeUntracked: false`
 * and `ResourceRegistry.crawl` never overrides either — so inside a git working
 * tree the resources lanes are answered by `git ls-files` over **tracked files
 * only**. A markdown file the author has created but not yet committed is
 * invisible to validation, and the command reports a confident green over a
 * corpus it did not fully see. `docs/architecture/resource-scanning-and-caching.md`
 * §2 records that split as a known, load-bearing inconsistency; skill discovery
 * already opted out of it (`crawlOneBase` sets `includeUntracked: true`, with a
 * comment that skills must be discoverable before being committed).
 *
 * Sourcing the population from the `filesystem` extent closes it, because that
 * extent enumerates the working tree rather than the index. Measured on a
 * two-file probe repository with one committed and one untracked broken link:
 * the walker reports `filesScanned: 1`, this lane reports 2.
 *
 * ## Why gitignored rows are dropped here rather than passed through
 *
 * The `filesystem` extent crawls with `respectGitignore: false` — that is its
 * entire reason for existing, and it is the only contributor that can ever write
 * `gitignored: true` (see `filesystem-extent.ts`). Handing that population
 * straight to the registry would not merely widen the scan by untracked files;
 * it would pull in every ignored path the config's `exclude` globs do not
 * happen to name — generated markdown, caches, downloaded corpora — and start
 * emitting findings about files the project told git to forget.
 *
 * So the filter is deliberate and it is the narrow choice: this lane admits
 * `tracked ∪ (untracked ∧ ¬ignored)`, which is exactly `includeUntracked: true`
 * and nothing more.
 *
 * ⚠️ **This paragraph used to end "the extent still enumerates the ignored half
 * — the rows exist, the column stays alive, and a future lens that wants them
 * can ask", and that is still true of the EXTENT and no longer true of THIS
 * LANE.** The capability is unchanged: realizing everything is still the
 * default, `gitignored` is still a live column, and a lens that wants the
 * ignored half still gets it by asking nothing. What changed is that declining
 * moved from *after* the rows were built to *before*, because building them was
 * never free. Measured on an 8,548-file adopter tree, warm, before and after:
 * **`lstat` 20,908 → 9,786, `realpathSync.native` 12,362 → 1,240, total
 * filesystem calls 40,698 → 18,454** — both sites falling by exactly the 11,122
 * rows this loop discarded, to answer a question about 1,289 markdown files.
 *
 * ⚠️ The remaining 9,786 `lstat` calls are NOT this change's residue to sweep up
 * casually: 8,548 of them are git-tracked paths whose mode bits git already
 * holds, but skipping those would null `mtime` for a tracked row and so change
 * what a shipped column description means. That is a separate decision.
 *
 * The declining is stated as a contributor PARAMETER, never a constructor
 * argument, so that a stored extent written under it cannot be served to a run
 * that asked the wide question: `zone_provenance` records the parameter set and
 * `selectRequestedContexts` keys on it. See `DECLINE_IGNORED`.
 *
 * ⚠️ With no `gitTracker` the projection cannot answer "ignored", so every row
 * arrives `gitignored: false` and this filter admits everything the crawl found.
 * That is correct rather than a hole: outside a git working tree there is no
 * ignore oracle to consult, and the incumbent's own non-git fallback is a full
 * walk with the same property.
 *
 * ## Cost
 *
 * Slower than `git ls-files`, structurally, and knowingly — the same trade
 * accepted for `vat inventory` (~5.3× there). A cold run populates the one
 * resources question — enumeration, keying and the blob stage — so that every
 * resources lane shares one stored population; a warm run reads the stored
 * extent alone. See {@link buildResourcePopulation}.
 * `resource-scanning-and-caching.md` §3.1/§3.3 is where that cost gets
 * re-sourced (~140 ms against 1,537 ms warm on an 8,496-path adopter tree, with
 * content keys included).
 *
 * ⚠️ **"Not narrowable" was too broad a claim and is now split in two.** What
 * cannot be narrowed is the *kind* of member — dropping non-markdown paths loses
 * real members this lane exists to recover, which
 * `projection-extent-narrowing.test.ts` measures rather than argues. What CAN be
 * declined is the gitignored half, because this lane never admitted it in the
 * first place; the two moves look alike and are not.
 */

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';

import { RealizationConditionRowSchema, type RealizationConditionRow } from '../schemas/projection-resources.js';
import type { JsonValue } from '../schemas/projection-shared.js';

import { ContributorRegistry } from './contributor.js';
import { AgenticConventionContributor } from './contributors/agentic-convention.js';
import { ClaudeRulesScopeContributor } from './contributors/claude-rules-scope.js';
import {
  DECLINE_IGNORED,
  DEFAULT_CONTENT_DEMAND,
  FilesystemExtentContributor,
} from './contributors/filesystem-extent.js';
import { crawlSourceFor, type CrawlSource, type CrawlSourceKind } from './crawl-source.js';
import {
  populate,
  populationOracles,
  readStoredMembership,
  requestedContributors,
  type PopulateOptions,
  type PopulateResult,
  type PopulationOutcome,
  type TreePopulationOptions,
} from './merge.js';
import type { Projection } from './projection.js';

/**
 * A way to obtain the enumerated file population for a root, together with the
 * ONE root it is entitled to answer for.
 *
 * Lazy rather than a materialized list, so the CLI can decide the lane at its
 * boundary (where root discovery belongs) while the crawl stays lazy — a
 * registry that is never crawled must not pay for a projection.
 *
 * ## Why the root travels WITH the enumerator
 *
 * A bare `(root: string) => Promise<readonly string[]>` cannot express the one
 * invariant this seam has: a source built against tree A, handed tree B, would
 * build B's population using A's ignore oracle and — with a store open — write
 * it under **A's extent key**. Poisoning the key is worse than a wrong answer in
 * one run, because the next run reads it back and believes it.
 *
 * With the root here, "the wrong tree" is a comparison rather than a convention,
 * and `ResourceRegistry.populationFrom` makes it at the single place a source
 * ever meets a root — so every present and future forwarding site is safe by
 * construction instead of by a comment. The rejected alternative was a parallel
 * `populationSourceRoot` argument beside the function, which is a second thing to
 * keep in step and therefore the same bug one level out.
 *
 * ⚠️ **Compare RESOLVED, never as raw strings.** A trailing separator, a
 * `a/../a` spelling, a symlinked temp root and (where the filesystem folds case)
 * a differently-cased spelling all name the same directory. An over-strict
 * comparison declines every one of them, and its symptom is not an error but a
 * lane that quietly stopped helping. `sameDirectory` in `../utils.ts` is that
 * comparison.
 */
export interface ResourcePopulationSource {
  /**
   * The absolute root this source can answer for, and no other.
   *
   * Need not be normalised — the guard resolves both sides — but must name the
   * tree the enumeration was actually built against, not the tree a caller
   * happens to be crawling.
   */
  readonly root: string;
  /**
   * Enumerate the population.
   *
   * @param root - Absolute root to enumerate, which the guard has already
   *   established names the same directory as {@link ResourcePopulationSource.root}
   * @param outputs - The trees the calling verb writes (the registry's `CrawlOptions.outputs`),
   *   `[]` for none: a fault on one of them, inside one or on a directory holding one is the
   *   destination's, any other the input's
   * @returns Every file the population admits, and the population-time
   *   conditions the enumeration recorded — see {@link ResourceEnumeration}
   */
  enumerate(root: string, outputs: readonly string[]): Promise<ResourceEnumeration>;
}

/**
 * What a population source hands the registry: the members, what the
 * enumeration could say about itself while finding them, and where the answer
 * came from.
 *
 * `conditions` is the projection's `realization_conditions` table for the
 * extents this lane registered — a gitignored directory the enumerator could
 * not list, a path two identities collided on. It rides WITH the paths rather
 * than being fetched afterwards because there is no afterwards: the projection
 * is built and discarded inside `enumerate`, and a fact not carried out of it
 * is gone. The registry surfaces each row as a finding with the row's own code
 * and severity; a source with nothing to say hands over an empty list, which is
 * what the walk lane always does.
 *
 * `outcome` and `extentSource` ride the same way, and are REQUIRED for the
 * same reason: the registry hands them back from `crawl` beside the resources,
 * which is the ONE route a caller learns where its population came from. A
 * source that kept them on the side would leave that route empty and still
 * compile.
 */
export interface ResourceEnumeration {
  /** Absolute paths of every file the population admits, in no promised order — the registry orders them. */
  readonly paths: readonly string[];
  /** Population-time conditions recorded while enumerating, in canonical order (see `canonicalConditions`). */
  readonly conditions: readonly RealizationConditionRow[];
  /** Whether the store served this population — the outcome `populate()` returned for it, the only producer. */
  readonly outcome: PopulationOutcome;
  /**
   * Which enumerator ran — the instance's own kind, not the env's request.
   * Read back from the environment it would prove what was requested, and the
   * request and the outcome come apart whenever {@link crawlSourceFor} declines
   * a root that is not in a repository.
   */
  readonly extentSource: CrawlSourceKind;
}

/**
 * Where one crawl's population came from, as `ResourceRegistry.crawl` reports it.
 *
 * `walk` when no source was offered AND when the offered source was declined:
 * the walk answered either way, and a caller told otherwise would publish the
 * projection lane for a crawl the projection never saw.
 */
export type CrawlPopulation =
  | { readonly lane: 'walk' }
  | { readonly lane: 'projection'; readonly outcome: PopulationOutcome; readonly extentSource: CrawlSourceKind };

/** Each {@link CrawlPopulation} lane, keyed so the compiler checks the list against the union both ways. */
const CRAWL_LANE_SET: Readonly<Record<CrawlPopulation['lane'], true>> = { walk: true, projection: true };

/** Every {@link CrawlPopulation} lane, as a runtime list — for a schema enum that must not be a hand-typed copy. */
export const CRAWL_LANES = Object.keys(CRAWL_LANE_SET) as [CrawlPopulation['lane'], ...Array<CrawlPopulation['lane']>];

/**
 * Register the contributors every resources lane shares, and the parameters
 * they run under — the ONE question every resources lane asks the store.
 *
 * Every lane registers this set under {@link DEFAULT_CONTENT_DEMAND}:
 * {@link buildResourcePopulation}, which reads only membership, and
 * {@link buildResourceProjection}, which reads the rows a query runs against.
 * One registry and one demand mean one store key, so a population either lane
 * wrote serves the other, and membership is a view over that one population
 * rather than a cheaper question with a key of its own. Neither the demand nor
 * the classifier set is a parameter: a lane that could narrow either would ask a
 * different question and evict the other's extent, run after run.
 *
 * 🪤 The demand reaches the store key only through the filesystem contributor's
 * {@link ExtentContributor.registrationQuestion}; `DECLINE_IGNORED` reaches it as
 * a parameter set the reuse rule sees. Both are fixed here.
 *
 * @param source - The run's single enumerator, already selected by its caller
 *   so the instance stays nameable
 * @returns The registry and the parameter sets to hand {@link populate}
 */
function resourceContributors(source: CrawlSource): { registry: ContributorRegistry; parameters: Record<string, JsonValue> } {
  const registry = new ContributorRegistry();
  const filesystem = new FilesystemExtentContributor(() => source, DEFAULT_CONTENT_DEMAND);
  registry.register(filesystem);

  // AFTER the enumerator, and the order is load-bearing: `byStratum` returns
  // registration order and the driver runs base contributors sequentially, each
  // reading the base the previous ones grew. Registered first, this would
  // classify an empty realization table and report a complete, empty extent —
  // the same silent-success shape `ContributorRegistry.forKind` refuses.
  registry.register(new AgenticConventionContributor());

  // `closure` stratum, so registration order relative to the base contributors
  // does not decide when it runs. ⛔ On every lane: with the producer missing
  // from the lane `vat resources query`/`check` populate through, a SQL question
  // about dead rule globs returned zero rows over a corpus full of them — an
  // empty table and a clean corpus are the same answer.
  registry.register(new ClaudeRulesScopeContributor());

  return {
    registry,
    // Every lane drops every `gitignored` row, so it asks the extent not to
    // produce them — see `DECLINE_IGNORED`. Measured on an 8,548-file adopter
    // tree, the declined rows were 11,122 of 20,908 and cost 11,122 `lstat` plus
    // ~12,362 `realpathSync.native` calls, every one of them for a row the
    // caller then discarded.
    //
    // Keyed off the INSTANCE's own id rather than a second copy of the literal:
    // a parameter set filed under an id no registered contributor answers to is
    // silently ignored, so the two must not be able to drift.
    parameters: { [filesystem.id]: DECLINE_IGNORED },
  };
}

/**
 * What every resources lane hands {@link populate} for one root and one
 * enumerator: {@link resourceContributors}' question plus the run's oracles.
 *
 * @param options - The lane's options, for its oracles and blob-stage observer
 * @param root - The resolved root
 * @param source - The run's single enumerator
 * @returns The options to read the store and to populate with — one object, so
 *   both compute one key
 */
function resourcePopulateOptions(options: TreePopulationOptions, root: string, source: CrawlSource): PopulateOptions {
  const { registry, parameters } = resourceContributors(source);
  return { root, registry, parameters, onBlobPopulation: options.onBlobPopulation, ...populationOracles(options) };
}

/**
 * A population's membership: the ONE conversion from realization and condition
 * rows to a {@link ResourceEnumeration}, on a store hit and on a derive alike.
 *
 * Paths are not sorted here: the registry orders every batch it admits
 * (`admissionOrder()`), whoever enumerated it. Conditions are, because a stored
 * extent comes back in SQLite's order — see {@link canonicalConditions}.
 *
 * @param root - The resolved root the rows' paths are relative to
 * @param rows - The population's realization and condition rows
 * @param rows.resourceRealizations - Its `resource_realizations`
 * @param rows.realizationConditions - Its `realization_conditions`
 * @param extentSource - The enumerator the run selected
 * @param outcome - Whether the store served the rows
 * @returns The members and what the population said about itself
 */
function membershipOf(
  root: string,
  rows: Pick<Projection, 'resourceRealizations' | 'realizationConditions'>,
  extentSource: CrawlSourceKind,
  outcome: PopulationOutcome,
): ResourceEnumeration {
  const paths = rows.resourceRealizations
    // `filesOnly: true` is the crawl contract every resources caller passes; the
    // extent enumerates directories too (the `claude-context` lens keys on one).
    // A row can be a member without being readable — a dangling symlink — and
    // admitting it would turn an enumeration difference into a
    // `RESOURCE_UNREADABLE` finding the walk never emits. `gitignored` is the
    // backstop for `DECLINE_IGNORED`: with no tracker the extent declines
    // nothing, and this is where the admitted set is STATED.
    .filter((row) => !row.isDirectory && row.exists && !row.gitignored)
    .map((row) => safePath.resolve(root, row.path));
  // Carried out whole rather than filtered here: which rows matter is the
  // consumer's call (the registry surfaces every one as a finding, and severity
  // overrides are the adopter's).
  return { paths, conditions: canonicalConditions(rows.realizationConditions), outcome, extentSource };
}

/**
 * Enumerate a root's files: the membership view over the one resources
 * population.
 *
 * ## A hit reads the extent alone
 *
 * The store is asked first, under the key every resources lane shares, through
 * `readStoredMembership`: the extent's realization and condition rows answer
 * membership, so a hit reads no blob table and populates nothing. That is why a
 * stored extent whose blob key was evicted is a hit here and a miss for
 * {@link buildResourceProjection}.
 *
 * ## A miss is the full population
 *
 * The same options `populate()` the full lane runs, blob stage included, and the
 * write that follows serves both lanes next time. So a cold membership run now
 * reads every non-ignored file: that is the cost of asking one question.
 *
 * @param options - The root, the run's oracles and the blob-stage observer
 * @param options.root - Absolute root to enumerate
 * @param options.outputs - The trees the calling verb writes, `[]` for none: the
 *   one declaration of which side a fault is on (see `crawlSourceFor`). Kept out
 *   of the store key, which is sound only because a fault on an output throws
 *   (`refuse`, `listing-refusal.ts`) rather than storing a side-labelled row
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic: with
 *   no tracker no row is `gitignored`, so the ignored half of a git tree would
 *   be admitted rather than declined
 * @param options.cache - A projection store to answer this enumeration from, or
 *   omitted to populate every time. A hit reports the enumerator this process
 *   SELECTED: the key already holds the selector, the tracker's presence and the
 *   root, so the selection is the enumerator that wrote the rows
 * @param options.onBlobPopulation - Receives what the blob stage derived and
 *   what it REFUSED to derive on a miss; never called on a hit
 * @returns The population, the enumerator that produced it, and its outcome
 */
export async function buildResourcePopulation(
  options: TreePopulationOptions & { readonly outputs: readonly string[] },
): Promise<ResourceEnumeration> {
  const root = safePath.resolve(options.root);

  // Selected here, one call earlier than `FilesystemExtentContributor` would
  // select it, so the INSTANCE that enumerates is nameable afterwards. Which
  // matters because `crawlSourceFor` falls back SILENTLY: ask for git on a root
  // that is not in a repository and the walk answers, and an A/B varying only
  // `VAT_EXTENT_SOURCE` would read "the two agree" for "the switch did nothing".
  const source = crawlSourceFor(root, options.outputs);
  const populateOptions = resourcePopulateOptions(options, root, source);

  // Every contributor's context is requested, so a hit is exactly the rows a
  // derive below would have produced.
  const stored = await readStoredMembership(populateOptions, requestedContributors(populateOptions));
  if (stored !== undefined) return membershipOf(root, stored, source.kind, stored.outcome);

  const { projection, outcome } = await populate(populateOptions);
  return membershipOf(root, projection, source.kind, outcome);
}

/**
 * Populate the resources lane's tree and hand back the PROJECTION, content and
 * all — what a query about headings, links or sections reads.
 *
 * The same question as {@link buildResourcePopulation} (see
 * {@link resourceContributors}), so the same key: the two lanes share one stored
 * population, and only what each reads of it differs.
 *
 * ## 🔑 There is no store gate on the answer
 *
 * A caller with no projection store still gets rows here — this lane populates
 * either way, and a store, when there is one, only makes the second run cheap.
 * That is the rule the query surface is built on: an answer must not depend on
 * whether a cache happened to exist, or two callers hold differently-shaped
 * views of one tree.
 *
 * @param options - The root, the run's oracles, and the blob-stage observer
 * @param options.root - Absolute root to populate
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic: this
 *   lane passes `DECLINE_IGNORED`, so the tracker decides which members there
 *   ARE. With none, nothing is ignored and the population is the whole
 *   enumeration — correct rather than a hole, because outside a repository
 *   there is no ignore oracle to consult
 * @param options.cache - A projection store to answer this population from, or
 *   omitted to re-derive every time
 * @param options.collections - The project's `resources.collections`, so a
 *   declared `mimeType` routes the file it matches to a parser
 * @param options.onBlobPopulation - Receives what the blob stage derived and
 *   what it REFUSED to derive. **Required**: a corpus whose every document was
 *   declined as binary populates as empty and would otherwise report success
 * @returns The populated projection and `populate()`'s outcome for it
 */
export function buildResourceProjection(options: TreePopulationOptions): Promise<PopulateResult> {
  const root = safePath.resolve(options.root);
  // A projection is built to be read: the root is the tree the verb examines,
  // so no output is declared.
  return populate(resourcePopulateOptions(options, root, crawlSourceFor(root, [])));
}

/**
 * Every column of a condition row, `code` and `path` first: the order
 * {@link canonicalConditions} compares them in.
 */
const CONDITION_ORDER = [
  'code', 'path',
  ...RealizationConditionRowSchema.keyof().options.filter((column) => column !== 'code' && column !== 'path'),
] as const;

/** One condition's cells, in {@link CONDITION_ORDER}: what {@link compareConditionKeys} reads. */
type ConditionKey = ReadonlyArray<RealizationConditionRow[keyof RealizationConditionRow]>;

/**
 * Order two cells of one column: `null` first, numbers numerically, strings in
 * UTF-16 code-unit order, and the rest — booleans and the JSON payload column —
 * by their JSON text, which is total over the values one column can hold.
 *
 * @param left - One cell
 * @param right - The same column's cell in the other row
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects
 */
function compareCells(left: ConditionKey[number], right: ConditionKey[number]): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return compareCodeUnits(left, right);
  return compareCodeUnits(JSON.stringify(left), JSON.stringify(right));
}

/**
 * Order two conditions column by column, in {@link CONDITION_ORDER}: the first
 * column that differs decides, so two rows tie only when they are the same row.
 *
 * @param left - One condition's key
 * @param right - The other's
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects
 */
function compareConditionKeys(left: ConditionKey, right: ConditionKey): number {
  for (const [index, cell] of left.entries()) {
    const order = compareCells(cell, right[index] ?? null);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * A population's conditions in the ONE order every lane publishes them in:
 * `(code, path, …every other column)`.
 *
 * Sorted, because a stored extent comes back in SQLite's order, which carries no
 * `ORDER BY` guarantee: unsorted, a warm run published the same findings as the
 * cold run in a different order. Total over the row, so no two distinct rows tie
 * and fall back to whichever order arrived. Paths are not sorted here: the
 * registry orders every list it admits, whoever enumerated it.
 *
 * Decorated: each row's cells are read into a key once, not once per comparison.
 *
 * @param conditions - The population's conditions
 * @returns A new, sorted array; the input is not reordered
 */
function canonicalConditions(conditions: readonly RealizationConditionRow[]): RealizationConditionRow[] {
  return conditions
    .map((row) => ({ row, key: CONDITION_ORDER.map((column) => row[column]) }))
    .sort((left, right) => compareConditionKeys(left.key, right.key))
    .map(({ row }) => row);
}

/** Test-only seam — see `docs/architecture/README.md` "`__internal`". */
export const __internal = { canonicalConditions, CONDITION_ORDER } as const;
