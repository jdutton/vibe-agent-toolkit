/**
 * The **git** extent contributor (zones §7.1, §7.2) — what git can see.
 *
 * Membership is `tracked ∪ (untracked ∧ ¬ignored)`, i.e. `git ls-files --cached
 * --others --exclude-standard`. That is deliberately *not* the working
 * filesystem: a gitignored build artifact is on disk, readable by an agent, and
 * absent from every clone CI makes. "Claude sees output the git extent cannot"
 * is a different base, not an intersection of one — which is exactly why this
 * contributor and the filesystem one both exist rather than one of them
 * filtering the other.
 *
 * ## Every realization here has `gitignored: false`, by construction
 *
 * The column is still recorded — it is a *realization* column, and this
 * contributor is not the only producer of realizations. It becomes a real
 * question for a path that arrives from somewhere else, chiefly a
 * parse-discovered link target that resolves into ignored territory. Nothing
 * this contributor enumerates can be ignored, so a `true` here would be a bug in
 * the crawl, not a fact about the corpus.
 *
 * ## No answer from git is an error, never an empty extent
 *
 * `gitLsFiles` returns `null` for every way asking can fail — no `git` on
 * `PATH`, a corrupt or unreadable `.git`, a non-repository root — and from the
 * row set alone that is indistinguishable from "git answered, and this
 * repository is empty". Both leave zero members. So this contributor asks
 * {@link GitTracker.isUsable} first and throws when git did not answer, matching
 * `ContributorRegistry.forKind`'s stance that an empty extent is a confident
 * wrong answer rather than a result.
 *
 * ## The crawl route changes the population, and that is not fixed here
 *
 * `followSymlinks: false` is **ignored** on the `git ls-files` route
 * (`file-crawler.ts:199-219`), so a committed symlink is a member here while the
 * manual walk would skip it. That divergence is pinned by
 * `enumeration-symlink-divergence.integration.test.ts` and changing it moves
 * enumeration on real corpora, so it is a product decision with its own
 * changelog entry — not something this contributor quietly reconciles.
 */

import {
  crawlDirectory,
  NEVER_CRAWL_GLOBS,
} from '@vibe-agent-toolkit/utils';

import type {
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import type { ContributorStratum, ExtentContribution, ExtentContributor } from '../contributor.js';
import type { ProjectionBase } from '../projection.js';
import { collectRealization } from '../realizations.js';

import { extentContextId } from './context-id.js';

/** `zone_provenance.contributorId` for the git extent. */
export const GIT_EXTENT_CONTRIBUTOR_ID = 'builtin:git';

/** The `resolution_contexts.kind` this contributor populates. */
export const GIT_EXTENT_KIND = 'git';

/**
 * `resources.origin` for an identity this contributor first observed.
 *
 * The *kind*, not the contributor id: `resources` rows are extent-independent
 * (one identity, however many extents observe it), so `origin` is the coarse
 * "which lane first knew about this" label, and `zone_provenance.contributorId`
 * is where the precise instance lives. Spelled the same way the filesystem
 * contributor spells its own, so a query over `origin` sees one vocabulary.
 */
export const GIT_EXTENT_ORIGIN = 'git';

/**
 * Populates the git extent of one corpus root.
 *
 * `base` stratum: what git tracks is acyclic and does not depend on what any
 * other contributor found, so it runs exactly once.
 */
export class GitExtentContributor implements ExtentContributor {
  readonly id: string = GIT_EXTENT_CONTRIBUTOR_ID;
  readonly kind: string = GIT_EXTENT_KIND;
  readonly stratum: ContributorStratum = 'base';

  /**
   * Enumerate `tracked ∪ (untracked ∧ ¬ignored)` and return the rows for it.
   *
   * **The tracker comes from `base`, never from a constructor and never built
   * here.** §7.1 says a contributor reads the base projection; one that spawned
   * its own `git ls-files` would be reaching outside that seam, would pay a
   * second subprocess per run, and — the part that is a correctness bug rather
   * than a cost — could answer index-casing questions differently from the
   * `ResourceIdentityMap` that minted the ids these rows carry.
   *
   * @param base - Read-only projection, supplying the corpus root, the shared
   *   identity map ids must be minted through, and the run's git oracle
   * @param _parameters - Unread: this extent has no parameters. Its population is
   *   git's answer, and narrowing it with globs would produce an extent whose
   *   name says "git" and whose membership does not.
   * @returns The git extent's context, resources, realizations and memberships
   * @throws When the base carries no git oracle, or git did not answer for this
   *   root — an empty git extent is a confident wrong answer, not a result
   */
  async contribute(base: ProjectionBase, _parameters: JsonValue): Promise<ExtentContribution> {
    const tracker = base.gitTracker;
    if (tracker === undefined) {
      throw new Error(
        `No git oracle is available for "${base.root}" — the projection was built without a GitTracker.`
        + ' Register this contributor only for a corpus whose ProjectionBuilder was given one;'
        + ' reporting an empty git extent instead would be indistinguishable from an empty repository.',
      );
    }
    await tracker.initialize({ includeUntracked: true });
    if (!tracker.isUsable()) {
      throw new Error(
        `git did not answer for "${base.root}" — it is not a git repository, or git could not read it.`
        + ' Reporting an empty git extent would be indistinguishable from an empty repository, so this is an error.',
      );
    }

    const rootId = base.identities.rootId;
    // One git extent per root, so no discriminator.
    const extentId = extentContextId(GIT_EXTENT_KIND, rootId);
    const contexts: ResolutionContextRow[] = [{
      contextId: extentId,
      species: 'extent',
      kind: this.kind,
      rootId,
      extentContextId: null,
      role: null,
    }];

    // NEVER_CRAWL_GLOBS only, deliberately: the default exclude also drops
    // `dist/`, and a tracked file under `dist/` IS in git's extent whatever any
    // authored-content lane thinks of it.
    const absolutePaths = await crawlDirectory({
      baseDir: base.root,
      respectGitignore: true,
      includeUntracked: true,
      exclude: [...NEVER_CRAWL_GLOBS],
    });

    const resources = new Map<string, ResourceRow>();
    const memberships = new Map<string, ResourceExtentRow>();
    const realizations: ResourceRealizationRow[] = await Promise.all(
      absolutePaths.map(async (absolutePath) =>
        collectRealization(absolutePath, base.identities.idFor(absolutePath), {
          root: base.root,
          extentId,
          gitTracker: tracker,
          // Shared with every other contributor: a tracked file is realized here
          // and in the filesystem extent, and only one of those may read it.
          ...(base.contentCache !== undefined && { contentCache: base.contentCache }),
        })),
    );

    for (const realization of realizations) {
      const { resourceId } = realization;
      if (!resources.has(resourceId)) {
        resources.set(resourceId, {
          resourceId,
          kind: realization.isDirectory ? 'directory' : 'file',
          origin: GIT_EXTENT_ORIGIN,
          // Git recorded it, so it was observed — `exists` on the realization
          // carries the separate fact that a tracked path may be missing from
          // the working tree.
          observed: true,
          fromEnumeration: true,
          vatId: null,
        });
      }
      memberships.set(resourceId, { resourceId, extentId });
    }

    return {
      contexts,
      resources: [...resources.values()],
      realizations,
      memberships: [...memberships.values()],
      // Tags are for classification contributors; conditions are emitted by the
      // builder when a realization loses a path collision, which one extent's
      // unique root-relative paths cannot produce.
      tags: [],
      conditions: [],
    };
  }
}
