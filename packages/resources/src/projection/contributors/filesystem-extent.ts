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

import type { GitTracker } from '@vibe-agent-toolkit/utils';

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
 * The parameter set that makes this extent decline the gitignored half.
 *
 * ## Why this is a PARAMETER and not a second constructor argument
 *
 * `contentDemand` above is a constructor argument because it changes what a row
 * *says* (`contentState`), never which rows exist. This changes **membership**,
 * and membership is the one thing a stored extent is read back for. Two runs
 * differing only in this produce different row sets, so
 * {@link PopulateOptions.parameters} is where it has to live: `zone_provenance`
 * records the parameter set verbatim, and `selectRequestedContexts` keys a
 * stored context on `(contributorId, parameterSet)`. A run asking the wide
 * question therefore **misses** an extent written by a run that asked the narrow
 * one, rather than being served a truncated population and reporting success.
 *
 * That is not a new rule invented here — `merge.ts` already states it: *"a
 * declaration hidden in a constructor would leave a provenance row that
 * under-describes the very extent its digest is supposed to make comparable"*.
 * Putting this in the constructor beside `contentDemand` would have been the
 * exact fault that sentence names, with a poisoned cache key as the symptom.
 *
 * ## What it costs the extent's own argument — nothing
 *
 * The class docstring's case for `respectGitignore: false` is a case about what
 * this extent *can* enumerate, and it is untouched: the default is still to
 * realize everything, `gitignored` is still a live column, and a lens that wants
 * the ignored half still gets it by asking nothing. What moves is that a lane
 * which provably discards those rows may now say so **before** they are paid
 * for. `buildResourcePopulation` is that lane — it consumes four columns and
 * drops every `gitignored` row in its own loop.
 *
 * Measured on an 8,548-file adopter tree, `vat resources scan` warm, before and
 * after: **`lstat` 20,908 → 9,786, `realpathSync.native` 12,362 → 1,240, total
 * filesystem calls 40,698 → 18,454.** Both sites fall by exactly the 11,122
 * gitignored rows, which is the arithmetic that identifies the saving rather
 * than merely reporting it — the `realpath` half because a path absent from
 * git's index misses `canonicalPathFor`'s tracked fast path, so the ignored
 * rows were paying for casing git could never have supplied.
 */
export const DECLINE_IGNORED: JsonValue = { ignored: 'decline' };

/**
 * Whether a parameter set asks this extent to skip the gitignored half.
 *
 * Anything that is not the exact {@link DECLINE_IGNORED} shape reads as "realize
 * everything" — the historical behaviour. The default direction matters more
 * than the parsing does: an unrecognised parameter set must never be able to
 * silently *narrow* a population, because a narrowed population is a green run
 * over a corpus nobody saw.
 *
 * @param parameters - The parameter set this run passed for this contributor
 * @returns True only for an explicit decline
 */
function declinesIgnored(parameters: JsonValue): boolean {
  return (
    typeof parameters === 'object'
    && parameters !== null
    && !Array.isArray(parameters)
    && parameters['ignored'] === 'decline'
  );
}

/**
 * The predicate that skips a path before it costs anything, or one that skips
 * nothing.
 *
 * Returned as a closure rather than evaluated per path so the "are we declining
 * at all?" question is answered once, and so the tracker is narrowed here
 * instead of at every call site.
 *
 * 🪤 **`knownToExist: true` is load-bearing and is the enumerator's own
 * observation, not an assumption.** Without it `isIgnoredByActiveSet` probes
 * with `existsSync` for every path absent from the active set — once per ignored
 * path, which is precisely the set being skipped — and the fix would trade an
 * `lstat` for a `stat` instead of removing it. The paths reaching that probe are
 * exactly the ones an enumerator just returned from a `readdir`.
 *
 * The only case where that could differ from `collectRealization`, which passes
 * `exists && symlinkResolves !== false` rather than raw existence, is a
 * **dangling symlink**: it is `exists: true` to `lstat` and absent to
 * `existsSync`, so the row builder falls back to `git check-ignore` where this
 * predicate would decline outright. **That set is empty by construction, not by
 * luck: no crawl source emits a symlink's own path** — the walk runs
 * `followSymlinks: false` and `GitCrawlSource` drops mode `120000` explicitly
 * (`crawl-source.ts`, "A SYMLINK IS NOT A MEMBER HERE"). A symlink therefore
 * never reaches this predicate, and `projection-filesystem-extent.test.ts` pins
 * that precondition rather than leaving the safety argued: if a source ever
 * starts emitting them, the test reddens here rather than the divergence
 * arriving silently.
 *
 * @param tracker - The run's ignore oracle, or absent outside a repository
 * @param parameters - This contributor's parameter set
 * @returns A predicate that is true for a path this run declines to realize
 */
function declinedPathFilter(
  tracker: GitTracker | undefined,
  parameters: JsonValue,
): (absolutePath: string) => boolean {
  if (tracker === undefined || !tracker.isUsable() || !declinesIgnored(parameters)) {
    return () => false;
  }
  return (absolutePath) => tracker.isIgnoredByActiveSet(absolutePath, true);
}

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
   * @param parameters - {@link DECLINE_IGNORED} to skip the gitignored half, or
   *   anything else (`null` included) to realize the whole enumeration. The root
   *   determines the rest of this extent, so this is the only thing to scope by
   * @returns The contributed rows
   */
  async contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution> {
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
    const declined = declinedPathFilter(base.gitTracker, parameters);

    for (const { absolutePath, contentHint } of enumerated) {
      // BEFORE `idFor` and before `collectRealization`, which is the whole
      // saving and the reason this is not a filter over the finished rows:
      // `idFor` costs a `realpathSync.native` for any path git's index cannot
      // supply casing for — i.e. every ignored one — and `collectRealization`
      // opens with an unconditional `lstat`. Declining afterwards would pay both
      // and then throw the answer away, which is what the consuming lane was
      // already doing.
      if (declined(absolutePath)) continue;
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
