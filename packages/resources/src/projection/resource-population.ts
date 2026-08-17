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
 * and nothing more. **The extent still enumerates the ignored half** — the rows
 * exist, the column stays alive, and a future lens that wants them can ask. Only
 * this consumer declines them.
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
 * accepted for `vat inventory` (~5.3× there). The population is obtained by a
 * filesystem walk that reads and keys the bytes it can, against one `ls-files`
 * spawn. `resource-scanning-and-caching.md` §3.1/§3.3 is where that cost gets
 * re-sourced (~140 ms against 1,537 ms warm on an 8,496-path adopter tree, with
 * content keys included); it is NOT narrowable here, because narrowing the
 * enumeration is what drops the members this lane exists to recover.
 */

import { safePath, type GitTracker } from '@vibe-agent-toolkit/utils';

import { ContributorRegistry } from './contributor.js';
import { FilesystemExtentContributor } from './contributors/filesystem-extent.js';
import { crawlSourceFor, type CrawlSourceKind } from './crawl-source.js';
import { BLOBS_SKIP, populate } from './merge.js';

/**
 * A way to obtain the enumerated file population for a root.
 *
 * A function rather than a value so the CLI can decide the lane at its boundary
 * (where root discovery belongs) while the crawl stays lazy — a registry that is
 * never crawled must not pay for a projection.
 *
 * @param root - Absolute root to enumerate
 * @returns Absolute paths of every file the population admits
 */
export type ResourcePopulationSource = (root: string) => Promise<readonly string[]>;

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
 * `resource-registry:add-resource` for 1,299 ms. So the stage spent 6,839 ms to
 * save 1,299 ms; the remainder is ~1,900 blobs parsed for nobody. Skipping it
 * moves those 176 parses back to `add-resource` and puts this lane at roughly
 * 1.5× the walk instead of 5.6×.
 *
 * ⚠️ The skip is safe **only** while nothing here reads a blob table. Registering
 * a closure contributor in this function without dropping the `blobs` argument
 * makes `populate()` throw, by design — see {@link PopulateOptions.blobs}. It
 * does not silently return a closure extent reduced to its own root.
 *
 * @param options - The root and the run's git oracle
 * @param options.root - Absolute root to enumerate
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic: with
 *   no tracker no row is `gitignored`, so the ignored half of a git tree would
 *   be admitted rather than declined
 * @returns The population and the enumerator that actually produced it
 */
export async function buildResourcePopulation(options: {
  root: string;
  gitTracker?: GitTracker | undefined;
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
  registry.register(new FilesystemExtentContributor(() => source));

  // No `parameters`: the filesystem extent is fully determined by the root, so
  // it runs under `null` and its provenance row says so honestly.
  const projection = await populate({
    root,
    registry,
    // See the header: this lane consumes realizations only, and the stage is
    // ~90% of its cold cost. Stated rather than inferred, and refused if a blob
    // reader is ever registered above.
    blobs: BLOBS_SKIP,
    ...(options.gitTracker !== undefined && { gitTracker: options.gitTracker }),
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
    // See the header: this consumer declines the ignored half; the extent still
    // enumerates it.
    if (row.gitignored) continue;
    paths.push(safePath.resolve(root, row.path));
  }
  return { paths, extentSource: source.kind };
}
