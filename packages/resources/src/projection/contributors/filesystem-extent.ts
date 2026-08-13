/**
 * The **filesystem** extent contributor — everything on disk under the root.
 *
 * This is the extent zones.md §2 names first, and its whole reason for existing
 * is the sentence that distinguishes it from the git extent: *"Claude sees the
 * filesystem, including gitignored build output, and follows `[]()`, `@` and
 * `.claude/rules` `paths:` globs"*. So the exclusion set here is
 * {@link NEVER_CRAWL_GLOBS} and **deliberately not** `BUILD_OUTPUT_GLOBS` — a
 * crawl that skipped `dist/` would model exactly the population the git extent
 * already models, and "Claude sees output the git extent cannot" would become
 * unrepresentable rather than merely unmeasured.
 *
 * Two further decisions worth stating, because both look like oversights:
 *
 * - **`filesOnly: false`.** A directory is a resource: `ResourceKindSchema` is
 *   an open vocabulary that names `"directory"` explicitly, `isDirectory` is a
 *   realization column, and the `claude-context` lens's entry point is a
 *   *directory*. Enumerating only files would leave that lens nothing to key on.
 * - **This contributor is the only one that can populate `gitignored`.** It
 *   looks like a git-extent fact, but the git extent enumerates tracked ∪
 *   (untracked ∧ ¬ignored) and so emits `gitignored: false` *by construction* —
 *   it is structurally incapable of observing an ignored path. This extent is
 *   the one that sees `dist/`, so it passes {@link ProjectionBase.gitTracker}
 *   to `collectRealization`; without that, no row anywhere would ever be
 *   `gitignored: true` and the column would be dead.
 *
 * ## Why this extent keys lazily — `contentDemand: 'deferGitignored'`
 *
 * The argument above is fully satisfied by **paths**. It never needed the
 * bytes: a gitignored path still gets a realization row, still reports
 * `exists`, `isDirectory` and `gitignored`, and is still a member of this
 * extent. Only the hash is withheld, and only until something asks for it.
 * That matters because `respectGitignore: false` is what makes this the
 * expensive extent — on a large adopter tree it enumerates 1.19 GB against
 * 40.8 MB of tracked source, and SHA-256-ing bytes no consumer ever reads is
 * the whole of that cost.
 *
 * **The general rule is not "gitignored".** It is: key eagerly where the bytes
 * are already essentially free from the discovery step, and defer everywhere
 * else. A source tree outside git entirely falls under the same rule.
 * `gitignored` is merely how that rule is *evaluated* here today, because it is
 * the only O(1) test available: `GitTracker` exposes no tracked-vs-ignored
 * predicate distinct from ignored — under the default `includeUntracked: true`,
 * tracked and untracked-not-ignored files share one active set.
 *
 * **The consequence, stated plainly:** with no git repository nothing is
 * gitignored, so nothing defers and behaviour is unchanged. That is deliberate.
 * Deferring in a non-git tree would leave the projection with almost no content
 * at all — a capability loss dressed up as a saving.
 */

import { crawlDirectory, NEVER_CRAWL_GLOBS } from '@vibe-agent-toolkit/utils';

import type {
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import type {
  ContributorStratum,
  ExtentContribution,
  ExtentContributor,
} from '../contributor.js';
import type { ProjectionBase } from '../projection.js';
import { collectRealization } from '../realizations.js';

import { extentContextId } from './context-id.js';

/** `zone_provenance.contributorId` for this contributor. Unique by registry rule. */
const CONTRIBUTOR_ID = 'builtin:filesystem';

/** The `resolution_contexts.kind` this contributor populates. */
const FILESYSTEM_KIND = 'filesystem';

/** `resources.origin` for an identity this contributor first observed. */
const FILESYSTEM_ORIGIN = 'filesystem';

/**
 * Enumerates the working tree: every file *and* directory beneath the corpus
 * root that is not in {@link NEVER_CRAWL_GLOBS}.
 */
export class FilesystemExtentContributor implements ExtentContributor {
  readonly id: string = CONTRIBUTOR_ID;

  readonly kind: string = FILESYSTEM_KIND;

  readonly stratum: ContributorStratum = 'base';

  /**
   * Crawl the root and return one extent, its members, and their realizations.
   *
   * @param base - Read-only projection view; supplies the root and the shared
   *   identity map, so a path already identified by another contributor keeps
   *   its identity here
   * @param _parameters - Unused: the filesystem extent is fully determined by
   *   the root, so there is nothing to scope it by
   * @returns The contributed rows
   */
  async contribute(base: ProjectionBase, _parameters: JsonValue): Promise<ExtentContribution> {
    const { rootId } = base.identities;
    // One filesystem extent per root, so no discriminator.
    const extentId = extentContextId(FILESYSTEM_KIND, rootId);
    const context: ResolutionContextRow = {
      contextId: extentId,
      species: 'extent',
      kind: FILESYSTEM_KIND,
      rootId,
      extentContextId: null,
      role: null,
    };

    const absolutePaths = await crawlDirectory({
      baseDir: base.root,
      exclude: [...NEVER_CRAWL_GLOBS],
      // `followSymlinks` is three decisions — re-entry, membership and reach —
      // and all three come out the same way here. Identity already collapses a
      // symlink onto its target (`canonicalPathFor` resolves before hashing),
      // so following links would enumerate one blob many times under distinct
      // paths, each of which then loses the `(extentId, path)` race and lands
      // in `realization_conditions`, for no membership the target does not
      // already supply.
      followSymlinks: false,
      // Directories are resources, not merely containers of them.
      filesOnly: false,
      // The whole point of this extent: build output the git route cannot see.
      respectGitignore: false,
    });

    const resources = new Map<string, ResourceRow>();
    const realizations: ResourceRealizationRow[] = [];

    for (const absolutePath of absolutePaths) {
      const resourceId = base.identities.idFor(absolutePath);
      // Sequential on purpose: `collectRealization` reads and keys every file's
      // bytes, and fanning the whole crawl out at once puts one file handle per
      // corpus file in flight.
      const realization = await collectRealization(absolutePath, resourceId, {
        root: base.root,
        extentId,
        ...(base.gitTracker !== undefined && { gitTracker: base.gitTracker }),
        // The run's cache, never a local one: most of these paths are realized
        // by the git extent too, and the point is that the second realization
        // costs no read.
        ...(base.contentCache !== undefined && { contentCache: base.contentCache }),
        // See the class docstring: paths carry this extent's whole argument, so
        // the ignored half of the tree gets rows without getting hashed.
        contentDemand: 'deferGitignored',
      });
      realizations.push(realization);
      if (!resources.has(resourceId)) {
        resources.set(resourceId, {
          resourceId,
          kind: realization.isDirectory ? 'directory' : 'file',
          origin: FILESYSTEM_ORIGIN,
          observed: true,
          fromEnumeration: true,
          vatId: null,
        });
      }
    }

    const memberships: ResourceExtentRow[] = [...resources.keys()].map((resourceId) => ({
      resourceId,
      extentId,
    }));

    return {
      contexts: [context],
      resources: [...resources.values()],
      realizations,
      memberships,
      tags: [],
      conditions: [],
    };
  }
}
