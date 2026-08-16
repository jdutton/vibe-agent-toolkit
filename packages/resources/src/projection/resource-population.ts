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
import { populate } from './merge.js';

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
 * Enumerate a root's files from a base-only projection.
 *
 * Registers the `filesystem` extent and nothing else: resources membership is
 * the base extent itself, so unlike `buildInventoryPopulation` there is no
 * closure stratum to iterate and no per-subject contributor to register. The
 * blob stage still runs — that is `populate`'s own, and it is what makes the
 * bytes this walk already read available to the shared content cache instead of
 * being read a second time by every downstream parse.
 *
 * @param options - The root and the run's git oracle
 * @param options.root - Absolute root to enumerate
 * @param options.gitTracker - The ignore oracle, or omitted. Not cosmetic: with
 *   no tracker no row is `gitignored`, so the ignored half of a git tree would
 *   be admitted rather than declined
 * @returns Absolute file paths, sorted by the projection's own row order
 */
export async function buildResourcePopulation(options: {
  root: string;
  gitTracker?: GitTracker | undefined;
}): Promise<readonly string[]> {
  const root = safePath.resolve(options.root);

  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());

  // No `parameters`: the filesystem extent is fully determined by the root, so
  // it runs under `null` and its provenance row says so honestly.
  const projection = await populate({
    root,
    registry,
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
  return paths;
}
