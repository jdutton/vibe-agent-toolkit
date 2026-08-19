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
 * ## Why this extent keys lazily, and why the POLICY belongs to the caller
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
 * `gitignored` is merely how that rule is *evaluated* under
 * {@link DEFAULT_CONTENT_DEMAND}, because it is the only O(1) test available:
 * `GitTracker` exposes no tracked-vs-ignored predicate distinct from ignored —
 * under the default `includeUntracked: true`, tracked and untracked-not-ignored
 * files share one active set.
 *
 * **The consequence of THAT policy, stated plainly:** with no git repository
 * nothing is gitignored, so nothing defers. Deferring in a non-git tree would
 * leave a blob-reading lane with almost no content at all — a capability loss
 * dressed up as a saving.
 *
 * ⚠️ **But "which half of the tree" was never the whole question, and a literal
 * here answered it once for every lane.** This contributor serves more than one:
 * `buildInventoryPopulation` runs the blob stage over what this extent keys, so
 * its bytes are load-bearing; `buildResourcePopulation` consumes exactly four
 * columns — `isDirectory`, `exists`, `gitignored`, `path` — discards the
 * `Projection`, and skips the blob stage outright. Measured on an 8,548-file
 * monorepo, keying for that second lane was **~1,684 ms of a 13,714 ms cold run,
 * reading 152.9 MB**, and every byte of it was thrown away. No single literal is
 * right for both, so the demand is a **constructor parameter** and each lane
 * states its own — the policy stays inspectable and serializable (see
 * {@link ContentDemand}), it is simply no longer decided here.
 *
 * ## ⚠️ This extent's COST is not settled here — see the git lane before optimising
 *
 * Everything above argues why this extent must ENUMERATE what it enumerates.
 * That is a claim about the population, and it stands. It is **not** a claim
 * that the population must be obtained by walking the filesystem, and reading it
 * as one has already cost this project a wrong conclusion ("this half is
 * structural, not scopable") reached by reasoning from this comment alone.
 *
 * `docs/architecture/resource-scanning-and-caching.md` §3.1 is the authority on
 * cost. For the TRACKED portion git already holds both the path list and a
 * content hash, so `@vibe-validate/git`'s `getGitTreeHash()` + `git ls-files -s`
 * against the temp index yields paths *and* content keys in ~140 ms on an
 * 8,496-path adopter tree, against 1,537 ms warm here — dirty and untracked
 * files included and correctly hashed. What git cannot supply is the ignored
 * remainder, which is exactly the population this extent exists for; §6 tracks
 * sourcing that via `ls-files --others --ignored --directory` (a 369-entry prune
 * list, 60 ms) rather than a full walk.
 *
 * **Narrowing and re-sourcing are different moves.** This extent cannot be
 * narrowed — dropping non-markdown loses real members, and that is measured now
 * rather than reasoned. `test/projection-extent-narrowing.test.ts` builds
 * `SKILL.md → scripts/tool.mjs → docs/note.md` and withholds the non-markdown
 * row: the skill loses the script, which is a direct link target of its own
 * root, AND the leaf reachable no other way.
 *
 * 🪤 The transitive half rests on one precondition that fixture also pins. The
 * script's reference lexes as `markdown-link` — a JSDoc comment is markdown —
 * while its bare `readFileSync('docs/note.md')` token lexes as `bare-token`,
 * which the default `follow` set does not traverse. What is proven is that
 * non-markdown files carry *followed* references, not that every path a script
 * names is walked; widen `follow` and the fixture reds so the measurement is
 * retaken against the wider set.
 *
 * It can be re-sourced.
 */

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
import { crawlSourceFor, type CrawlSource } from '../crawl-source.js';
import type { ProjectionBase } from '../projection.js';
import { collectRealization, type ContentDemand } from '../realizations.js';

import { extentContextId } from './context-id.js';

/** `zone_provenance.contributorId` for this contributor. Unique by registry rule. */
const CONTRIBUTOR_ID = 'builtin:filesystem';

/** The `resolution_contexts.kind` this contributor populates. */
const FILESYSTEM_KIND = 'filesystem';

/** `resources.origin` for an identity this contributor first observed. */
const FILESYSTEM_ORIGIN = 'filesystem';

/**
 * The demand a caller that states none gets — the historical literal, unmoved.
 *
 * Named rather than defaulted inline so that "the lane that did not opt in is
 * unchanged" is one readable fact instead of a literal in a parameter list.
 * `buildInventoryPopulation` is that lane: it runs the blob stage over what this
 * extent keys, and a default that quietly became `'deferred'` would empty that
 * stage while every membership assertion about it stayed green.
 */
export const DEFAULT_CONTENT_DEMAND: ContentDemand = 'deferGitignored';

/**
 * Enumerates the working tree: every file *and* directory beneath the corpus
 * root that is not in {@link NEVER_CRAWL_GLOBS}.
 */
export class FilesystemExtentContributor implements ExtentContributor {
  readonly id: string = CONTRIBUTOR_ID;

  readonly kind: string = FILESYSTEM_KIND;

  readonly stratum: ContributorStratum = 'base';

  /** Enumerates paths and keys bytes; reads no blob-keyed table. */
  readonly readsBlobs = false;

  readonly #sourceFor: (root: string) => CrawlSource;

  readonly #contentDemand: ContentDemand;

  /**
   * @param sourceFor - How to obtain this extent's enumerator, defaulting to
   *   {@link crawlSourceFor}. Injected only so the parity suite can pin one
   *   implementation against the other on a single root; production selects at
   *   the seam, never per construction site
   * @param contentDemand - Whether this registration wants the bytes keyed, and
   *   which half of the tree. A **lane's** decision, not this class's — see the
   *   class docstring — defaulting to {@link DEFAULT_CONTENT_DEMAND} so a caller
   *   that has not thought about it is left exactly where it was
   */
  constructor(
    sourceFor: (root: string) => CrawlSource = crawlSourceFor,
    contentDemand: ContentDemand = DEFAULT_CONTENT_DEMAND,
  ) {
    this.#sourceFor = sourceFor;
    this.#contentDemand = contentDemand;
  }

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

    // Which enumerator answers is chosen at the seam, never here — see
    // `crawl-source.ts`. Both implementations return the same set for the same
    // root; they differ in what they cost and in what they already know.
    const enumerated = await this.#sourceFor(base.root).enumerate();

    const resources = new Map<string, ResourceRow>();
    const realizations: ResourceRealizationRow[] = [];

    for (const { absolutePath, contentHint } of enumerated) {
      const resourceId = base.identities.idFor(absolutePath);
      // Sequential on purpose: under a keying demand `collectRealization` reads
      // and keys every file's bytes, and fanning the whole crawl out at once
      // puts one file handle per corpus file in flight.
      const realization = await collectRealization(absolutePath, resourceId, {
        root: base.root,
        extentId,
        ...(base.gitTracker !== undefined && { gitTracker: base.gitTracker }),
        // The run's cache, never a local one: most of these paths are realized
        // by the git extent too, and the point is that the second realization
        // costs no read.
        ...(base.contentCache !== undefined && { contentCache: base.contentCache }),
        // The registering LANE's policy, never a literal chosen here: paths
        // carry this extent's whole argument, and which lanes additionally need
        // the bytes is a fact about the lanes. See the class docstring.
        contentDemand: this.#contentDemand,
        ...(contentHint !== null && { contentHint }),
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
