/**
 * The producer that makes `resource_tags` a populated table rather than a
 * plumbed one.
 *
 * ## Why this is a new contributor and not a line in an existing one
 *
 * Six sites return `tags: []` today — the git, filesystem, package and plugin
 * extents, and the closure extent twice — and none of them should stop.
 * `git-extent.ts` states the rule the other five follow: *"Tags are for
 * classification contributors."* An extent contributor answers *what exists*;
 * this one answers *what it is*. Folding classification into an enumerator
 * would mean the same file classified differently depending on which enumerator
 * found it, which is exactly the property `resource_tags` is keyed to forbid.
 *
 * ## 🪤 A contributor that declares no context records that it never ran
 *
 * `runContributor` writes one `zone_provenance` row **per declared context**,
 * so a classification contributor returning `contexts: []` has its digest
 * computed and thrown away: nothing records that it ran, and the reuse rule —
 * which compares `(contributorId, parameterSet)` against provenance — cannot
 * see it. So this declares a real extent whose members are exactly the
 * resources it classified. That is not a formality dressed up as a zone: *"the
 * agentic-convention surface of this tree"* is a set of resources, it is
 * defined by this contributor, and a consumer asking for it wants precisely
 * those members.
 *
 * It contributes no `resources` and no `realizations` rows — every identity it
 * tags was minted by whichever enumerator found the path — which is why
 * membership without realization is the correct shape here and not an
 * omission.
 *
 * ## 🪤 Identity collapse, and why loading is reduced across realizations
 *
 * `resource_tags` is keyed `(resourceId, tag, value, source)` and `resourceId`
 * canonicalises through `realpathSync.native`, so a symlink at
 * `.claude/agents/foo.md` pointing at `docs/foo.md` mints ONE identity. Two
 * realizations of that identity classify differently — `subagent` at one path,
 * nothing at the other — and the table has no column to say which path produced
 * which row. Emitting both verbatim would put two contradictory `loading` rows
 * under one key, and a budget check joining on it would double-count.
 *
 * So the classes are reduced with {@link strongestLoading} across *all* of an
 * identity's realizations before a row is written: one `loading` row per
 * identity, and the strongest wins, which is the same direction the per-path
 * rule takes and for the same reason — under-reporting is the failure mode a
 * budget check cannot tolerate. Convention tags are a union, which needs no
 * reduction because they are boolean-presence facts.
 */

import type {
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceTagRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import { classifyPath, LOADING_TAG, pluginRootsFrom, strongestLoading } from '../agentic-tags.js';
import type { PluginRoots, TagLoading } from '../agentic-tags.js';
import type { ExtentContribution, ExtentContributor } from '../contributor.js';
import type { ProjectionBase } from '../projection.js';

import { extentContextId } from './context-id.js';

/** This contributor's `resolution_contexts.kind`, and its id. */
const AGENTIC_CONVENTION_KIND = 'agentic-convention';

/** What one identity accumulated across every path that realizes it. */
interface Accumulated {
  readonly tags: Set<string>;
  readonly loadings: TagLoading[];
}

/**
 * Classify every realization and fold the results onto their identities.
 *
 * Separate from `contribute` because the fold is where the identity-collapse
 * rule lives — see the header — and because a path's classification and a
 * table's rows are two different concerns that were reading as one function.
 *
 * @param realizations - Every realization the base holds
 * @param pluginRoots - Plugin roots derived from the same path set
 * @returns Tags and loading classes per `resourceId`, empty for a tree that
 *   carries no recognised convention
 */
function accumulateByIdentity(
  realizations: readonly ResourceRealizationRow[],
  pluginRoots: PluginRoots,
): Map<string, Accumulated> {
  const byResource = new Map<string, Accumulated>();
  for (const row of realizations) {
    // A directory is never a convention: every tag here names a file the
    // harness reads, and `.claude/agents` itself is not a subagent.
    if (row.isDirectory) continue;
    const classified = classifyPath(row.path, row.basenameLower, pluginRoots);
    if (classified.length === 0) continue;

    let accumulated = byResource.get(row.resourceId);
    if (accumulated === undefined) {
      accumulated = { tags: new Set<string>(), loadings: [] };
      byResource.set(row.resourceId, accumulated);
    }
    for (const tag of classified) {
      // `value` carries the loading class; it is null for every boolean-presence
      // tag, which every other member of the vocabulary is.
      if (tag.tag !== LOADING_TAG) accumulated.tags.add(tag.tag);
      else if (tag.value !== null) accumulated.loadings.push(tag.value as TagLoading);
    }
  }
  return byResource;
}

/**
 * Tags every realized path with the agentic conventions its shape carries.
 *
 * `base` stratum: classification is a pure function of the enumerated path set,
 * so it is acyclic and runs once. `readsBlobs: false` is what lets it register
 * in the repo-wide lane at all — that lane declares `contentParsing: 'skip'`,
 * and the driver refuses a blob reader combined with the skip rather than
 * handing it empty tables.
 *
 * The consequence, stated so it is not discovered later: **no tag here can
 * depend on frontmatter.** That is why `rules-file` and `agents-md` carry no
 * `loading` value — see `agentic-tags.ts`.
 */
export class AgenticConventionContributor implements ExtentContributor {
  readonly id = AGENTIC_CONVENTION_KIND;
  readonly kind = AGENTIC_CONVENTION_KIND;
  readonly stratum = 'base' as const;
  readonly readsBlobs = false;

  /**
   * Classify every realization the base holds.
   *
   * Registration order matters and is preserved by `ContributorRegistry`: this
   * must be registered *after* the enumerator whose realizations it reads, or
   * it classifies an empty table and reports a complete, empty extent.
   *
   * @param base - Read-only projection view; `resourceRealizations` is the input
   * @param _parameters - Unused. Classification is not scoped: a tree's
   *   conventions are the same question however the caller narrowed the crawl
   * @returns One extent, its members, and their tags
   */
  contribute(base: ProjectionBase, _parameters: JsonValue): Promise<ExtentContribution> {
    const { rootId } = base.identities;
    const extentId = extentContextId(AGENTIC_CONVENTION_KIND, rootId);
    const context: ResolutionContextRow = {
      contextId: extentId,
      species: 'extent',
      kind: AGENTIC_CONVENTION_KIND,
      rootId,
      extentContextId: null,
      role: null,
    };

    // Derived from the whole path set before any path is classified: a plugin
    // root is a fact about the tree, and asking it per-path would mean the
    // answer depended on iteration order.
    const pluginRoots = pluginRootsFrom(base.resourceRealizations.map((row) => row.path));

    const byResource = accumulateByIdentity(base.resourceRealizations, pluginRoots);

    const tags: ResourceTagRow[] = [];
    const memberships: ResourceExtentRow[] = [];
    for (const [resourceId, accumulated] of byResource) {
      memberships.push({ resourceId, extentId });
      for (const tag of accumulated.tags) {
        tags.push({ resourceId, tag, value: null, source: this.id });
      }
      const loading = strongestLoading(accumulated.loadings);
      if (loading !== undefined) {
        tags.push({ resourceId, tag: LOADING_TAG, value: loading, source: this.id });
      }
    }

    return Promise.resolve({
      contexts: [context],
      // Empty on purpose: every identity tagged here was minted by the
      // enumerator that found its path, and re-emitting the rows would claim
      // this contributor discovered them.
      resources: [],
      realizations: [],
      memberships,
      tags,
      conditions: [],
    });
  }
}
