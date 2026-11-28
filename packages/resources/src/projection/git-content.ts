/**
 * The run's git-content listing: the `git_content` relation, and the input every relation defined
 * over git content reads (the `tsconfig_*` family hands this same listing to its step).
 *
 * 🔑 **No listing of its own.** It is {@link snapshotGitContentMembers}, the function the git crawl
 * derives its snapshot half from, over the run's memoized snapshot (`gitTreeSnapshot`, inside the
 * CLI's `withGitSnapshotCache` bracket): on the default git crawl source the crawl has already taken
 * that snapshot, so this spends no `git.snapshots`; with the filesystem crawl forced it takes the
 * snapshot itself, and with no git answer it throws the snapshot's own coded error. Never
 * `freshGitTreeSnapshot`, which bypasses the bracket's memo.
 *
 * ⚠️ **A warm run is checked for listability.** A run served its extent from the store never
 * enumerated, so the crawl's refusal of a directory git cannot list never ran, and a file created
 * by name inside one since the extent was stored is in no snapshot and no key. A run that demands
 * git content and was served its extent calls `GitCrawlSource.assertListable()` once per root on
 * the git crawl source, refusing every directory git's own listing cannot open. (The cold crawl
 * also walks submodules' contents, which this check does not: a submodule subdirectory made
 * unreadable after a cold run is refused cold and not warm.)
 */

import { compareCodeUnits, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { GitContentRow } from '../schemas/projection-git-content.js';
import type { RootRow } from '../schemas/projection-resources.js';

import { gitExtentSelected, GitCrawlSource, snapshotGitContentMembers } from './crawl-source.js';
import { allDerivedSpecs } from './derived-table-registry.js';

/**
 * The relations whose answer is defined over git content: naming any one demands the run's
 * listing. 🔑 The ONE place a relation joins: `git_content` itself, the `tsconfig_*` family, whose
 * step answers `fileExists` and `readDirectory` from this listing alone, and the TypeScript resolve
 * step's three relations, whose host lists, and classifies targets against, the same listing.
 */
const GIT_CONTENT_PRODUCERS: ReadonlySet<string> = new Set(['git', 'tsconfig', 'tsResolve']);
const GIT_CONTENT_DEMANDERS: ReadonlySet<string> = new Set(allDerivedSpecs().filter((spec) => GIT_CONTENT_PRODUCERS.has(spec.producer)).map((spec) => spec.name));

/**
 * Whether the relations a run's statements name demand its git-content listing — and, on a run
 * served its extent from the store, the listability check that comes with it.
 *
 * @param named - The relations the statements name, by SQL name
 * @returns True when one of them is defined over git content
 */
export function gitContentDemanded(named: ReadonlySet<string>): boolean {
  return [...GIT_CONTENT_DEMANDERS].some((name) => named.has(name));
}

/**
 * The run's git content: one row per path git holds as content under each root, computed once per
 * run by the query lane.
 *
 * @param input - The run
 * @param input.roots - The run's roots, by id and absolute path
 * @param input.extentServed - Whether the run's extent was served from the store (it never enumerated)
 * @returns The rows, each root's in path order (code units)
 * @throws {DirectoryListingRefusedError} On a served run, for a directory git cannot list (`FS_FAULT`)
 * @throws The snapshot's own coded error when git gives no answer (`gitSnapshotFailureOf`)
 */
export function gitContentListing(input: {
  readonly roots: ReadonlyArray<Pick<RootRow, 'id' | 'path'>>;
  readonly extentServed: boolean;
}): readonly GitContentRow[] {
  return input.roots.flatMap((root) => {
    if (input.extentServed && gitExtentSelected(root.path)) new GitCrawlSource(root.path, []).assertListable();
    const { files, symlinks } = snapshotGitContentMembers(root.path);
    return [...files, ...symlinks]
      .map((absolutePath) => toForwardSlash(safePath.relative(root.path, absolutePath)))
      .sort(compareCodeUnits)
      .map((path) => ({ root: root.id, repository: '', path }));
  });
}
