/**
 * The **resource population**: the file list `vat resources scan`/`validate`
 * work from, answered by a projection instead of by `crawlDirectory`.
 *
 * This is the second production caller of `populate()` and the first outside
 * `vat inventory`. It is the lane Jeff sequenced ahead of the git-lane work, for
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
 * Slower than `git ls-files`, structurally, and knowingly — the same trade Jeff
 * accepted for `vat inventory` (~5.3× there). The population is obtained by an
 * enumeration plus one `lstat` per surviving path (no byte is read; see
 * `contentDemand: 'deferred'` below), against one `ls-files` spawn.
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

import { safePath } from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { CollectionConfig } from '../schemas/project-config.js';

import { ContributorRegistry } from './contributor.js';
import { AgenticConventionContributor } from './contributors/agentic-convention.js';
import { DECLINE_IGNORED, FilesystemExtentContributor } from './contributors/filesystem-extent.js';
import { crawlSourceFor, type CrawlSourceKind } from './crawl-source.js';
import {
  CONTENT_PARSING_SKIP,
  DISCARD_BLOB_POPULATION,
  populate,
  populationOracles,
  type PopulationCache,
} from './merge.js';

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
   * @returns Absolute paths of every file the population admits
   */
  enumerate(root: string): Promise<readonly string[]>;
}

/**
 * A population together with the enumerator that produced it.
 *
 * The kind travels WITH the paths rather than being obtainable by asking the
 * environment again, for the reason the `lane` field on a scan exists: reading
 * `VAT_EXTENT_SOURCE` back proves what was requested, and the request and the
 * outcome come apart whenever {@link crawlSourceFor} declines a root that is
 * not in a repository.
 */
export interface ResourcePopulation {
  /** Absolute file paths, sorted by the projection's own row order. */
  readonly paths: readonly string[];
  /** Which enumerator ran — the instance's own kind, not the env's request. */
  readonly extentSource: CrawlSourceKind;
}

/**
 * Enumerate a root's files from a base-only projection.
 *
 * Registers the `filesystem` extent and nothing else: resources membership is
 * the base extent itself, so unlike `buildInventoryPopulation` there is no
 * closure stratum to iterate and no per-subject contributor to register.
 *
 * ## Nothing here reads a file's CONTENT, and that is a pinned property
 *
 * The loop below consumes four columns — `isDirectory`, `exists`, `gitignored`,
 * `path` — every one of which `lstat` and the ignore oracle already answer.
 * `contentKey` is not among them, so this lane registers the extent under
 * `contentDemand: 'deferred'` and the population is obtained by enumeration and
 * `lstat` alone.
 *
 * It is a property rather than a comment: `zero-content-reads.integration.test.ts`
 * runs this function in a child process under an `fs` preload and asserts that
 * **no** content-read route fires for a path under the crawl root, with
 * `readdir`/`opendir` routed to a separate sink so the gate cannot be satisfied
 * by an enumeration that stopped enumerating.
 *
 * ## The blob stage is SKIPPED here, and the arithmetic that used to defend it
 *
 * This function reads four columns off `resource_realizations` and discards the
 * `Projection`. Not one blob row is consumed. The stage was nonetheless left
 * running on the argument that parsing every blob warms the shared parse cache
 * for the files the registry then admits — which is true, and is dwarfed by what
 * it costs. Measured on VAT's own repository (2,096 tracked files, 176 admitted
 * resources), cold, with the lab's `crawl` facet:
 *
 * | | walk lane | projection lane | `blob-population:derive` |
 * |---|---|---|---|
 * | cold | 1,363 ms | ~7,615 ms | 6,839 ms |
 *
 * The warming buys the 176 admitted parses, which the walker arm pays in full at
 * `resource-registry:admit` for 1,299 ms. So the stage spent 6,839 ms to
 * save 1,299 ms; the remainder is ~1,900 blobs parsed for nobody. Skipping it
 * moves those 176 parses back to `add-resource` and puts this lane at roughly
 * 1.5× the walk instead of 5.6×.
 *
 * ⚠️ The skip is safe **only** while nothing here reads a blob table. Registering
 * a closure contributor in this function without dropping the `contentParsing`
 * argument makes `populate()` throw, by design — see
 * {@link PopulateOptions.contentParsing}. It does not silently return a closure
 * extent reduced to its own root.
 *
 * @param options - The root and the run's git oracle
 * @param options.root - Absolute root to enumerate
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic: with
 *   no tracker no row is `gitignored`, so the ignored half of a git tree would
 *   be admitted rather than declined
 * @param options.cache - A projection store to answer this enumeration from, or
 *   omitted to enumerate every time. 🪤 A hit here returns rows a run with
 *   `contentParsing: CONTENT_PARSING_SKIP` wrote, so its `extentSource` reports the enumerator this
 *   process SELECTED rather than one that ran — a lane whose whole point is that
 *   nothing enumerated cannot also report who enumerated
 * @returns The population and the enumerator that actually produced it
 */
export async function buildResourcePopulation(options: {
  root: string;
  gitTracker?: GitTracker | undefined;
  cache?: PopulationCache | undefined;
  collections?: Readonly<Record<string, CollectionConfig>> | undefined;
}): Promise<ResourcePopulation> {
  const root = safePath.resolve(options.root);

  // Selected here, one call earlier than `FilesystemExtentContributor` would
  // select it, so the INSTANCE that enumerates is nameable afterwards. The
  // choice is still made by `crawlSourceFor` — the seam is unchanged and this
  // is not a second selection site — but the contributor discards the source as
  // soon as it has called it, and a kind nobody kept is a kind nobody can
  // report.
  //
  // Which matters because `crawlSourceFor` falls back SILENTLY: ask for git on
  // a root that is not in a repository and the walk answers. An A/B that varies
  // only `VAT_EXTENT_SOURCE` would then run one enumerator twice and produce two
  // identical populations, which reads as "the two agree" and actually means
  // "the switch did nothing". Those must not look alike.
  const source = crawlSourceFor(root);

  const registry = new ContributorRegistry();
  // `'deferred'`, and it is the same argument as `contentParsing: CONTENT_PARSING_SKIP` one layer
  // down — see the header. This lane reads four realization columns and
  // `contentKey` is not one of them, so every byte read to compute one was read
  // for nobody: ~1,684 ms of a 13,714 ms cold run, 152.9 MB, on an 8,548-file
  // monorepo. The rows still arrive; they arrive `contentState: 'deferred'`,
  // which is the state that says "enumerated, deliberately not read" rather
  // than any of the three that say there was nothing to read.
  //
  // ⚠️ Stated per LANE, never flipped in the contributor: `vat inventory`
  // registers the same class and DOES run the blob stage over what it keys.
  const filesystem = new FilesystemExtentContributor(() => source, 'deferred');
  registry.register(filesystem);

  // AFTER the enumerator, and the order is load-bearing: `byStratum` returns
  // registration order and the driver runs base contributors sequentially, each
  // reading the base the previous ones grew. Registered first, this would
  // classify an empty realization table and report a complete, empty extent —
  // the same silent-success shape `ContributorRegistry.forKind` refuses.
  //
  // Safe in THIS lane specifically because it declares `readsBlobs: false`:
  // `CONTENT_PARSING_SKIP` below is checked against that, and a blob reader
  // registered here would be a loud error rather than a degraded extent.
  registry.register(new AgenticConventionContributor());

  const projection = await populate({
    root,
    registry,
    // This lane drops every `gitignored` row in its own loop below, so it asks
    // the extent not to produce them — see `DECLINE_IGNORED`. Measured on an
    // 8,548-file adopter tree, the declined rows were 11,122 of 20,908 and cost
    // 11,122 `lstat` plus ~12,362 `realpathSync.native` calls, every one of them
    // for a row this function then discarded.
    //
    // Keyed off the INSTANCE's own id rather than a second copy of the literal:
    // a parameter set filed under an id no registered contributor answers to is
    // silently ignored, so the two must not be able to drift.
    parameters: { [filesystem.id]: DECLINE_IGNORED },
    // See the header: this lane consumes realizations only, and the stage is
    // ~90% of its cold cost. Stated rather than inferred, and refused if a blob
    // reader is ever registered above.
    contentParsing: CONTENT_PARSING_SKIP,
    // The ONE place discarding the counts is sound, and only because of the line
    // above: under `CONTENT_PARSING_SKIP` the blob stage never runs, so there is
    // no refusal to report and `populate()` never calls this. If the skip is ever
    // dropped, this line becomes a silence and must be replaced with a real
    // observer at the same time — that is why it is spelled out here rather than
    // being an argument nobody passed.
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...populationOracles(options),
  });

  const paths: string[] = [];
  for (const row of projection.resourceRealizations) {
    // `filesOnly: true` is the crawl contract every resources caller passes, and
    // the extent deliberately enumerates directories too (the `claude-context`
    // lens keys on one). Dropping them here rather than asking the extent not to
    // produce them keeps that capability where it belongs.
    if (row.isDirectory) continue;
    // A row can be a member without being readable — a dangling symlink is the
    // motivating case. Admitting it would turn an enumeration difference into a
    // `RESOURCE_UNREADABLE` finding the incumbent never emits.
    if (!row.exists) continue;
    // Retained even though `DECLINE_IGNORED` above means no such row can arrive
    // from a run with a usable tracker. It is not redundant: with no tracker the
    // extent declines nothing (correctly — outside a repository there is no
    // ignore oracle), and this line is where the lane's admitted set is STATED
    // rather than inferred from a parameter two files away. It is also the
    // backstop if the skip predicate and `collectRealization`'s `gitignored`
    // column ever drift, which would otherwise widen this lane in silence.
    if (row.gitignored) continue;
    paths.push(safePath.resolve(root, row.path));
  }
  return { paths, extentSource: source.kind };
}
