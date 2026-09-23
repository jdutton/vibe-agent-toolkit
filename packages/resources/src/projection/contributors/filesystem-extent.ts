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
 * root.
 *
 * 🪤 **The proven property is narrow, and it is the WHOLE claim — not a caveat
 * on a larger one.** What the fixture shows is that a markdown file links *to*
 * non-markdown files, so those files are closure **members**. It does not show
 * that they are closure **doors**: since parse routing became MIME-driven, a
 * `.mjs` routes to no document parser at all, so it emits no `markdown-link`,
 * `markdown-link-reference` or `markdown-definition` row for `follow` to
 * traverse. It still gets a blob, a token estimate, `measureContent` and
 * `findLexicalReferences` over raw source — every reference it carries lexes as
 * `bare-token`, which the default `follow` set does not traverse. The fixture's
 * leaf is on disk, is enumerated here, and is a member of nothing.
 *
 * This paragraph previously claimed the transitive half too — the leaf
 * "reachable no other way" — and that half was an artefact of routing every
 * non-`.html` file through remark: a JSDoc comment read as prose, so the script
 * *looked* like a door. It is stated as a correction rather than deleted so the
 * next reader does not re-derive the wider claim. Widening the default
 * `follow` to `bare-token` would make it one again, and was declined — 21,687
 * `bare-token` rows on this repo alone would turn every `import` specifier into
 * a closure edge. If that ever changes, the fixture's dead-end arm reds and this
 * paragraph is retaken against the wider set.
 *
 * It can be re-sourced.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import {
  isAbsoluteAnyPlatform,
  isFilesystemAccessError,
  isPathAbsentError,
  relativeEscapesRoot,
  safePath,
  toForwardSlash,
  toNfc,
  transientRefusalClause,
} from '@vibe-agent-toolkit/utils';
import type { DirectoryRefusal } from '@vibe-agent-toolkit/utils/crawl';
import { normalizePath } from '@vibe-agent-toolkit/utils/fs';
import type { GitTracker } from '@vibe-agent-toolkit/utils/git';

import {
  CONDITION_WITHOUT_REFERENCE,
  type RealizationConditionRow,
  type ResourceExtentRow,
  type ResourceRealizationRow,
  type ResourceRow,
} from '../../schemas/projection-resources.js';
import type { JsonValue } from '../../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../../schemas/projection-zones.js';
import type {
  ContributorStratum,
  ExtentContribution,
  ExtentContributor,
} from '../contributor.js';
import { crawlSourceFor, type CrawlSource, type CrawlSourceKind } from '../crawl-source.js';
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
 * `followSymlinks: false`, and `GitCrawlSource` drops one at a single seam
 * covering both the paths git described (mode `120000`) and the collapsed
 * `ls-files --others` entries it did not (`lstat`); see "A SYMLINK IS NOT A
 * MEMBER" in `crawl-source.ts`. A symlink therefore never reaches this
 * predicate, and `projection-filesystem-extent.test.ts` pins that precondition
 * rather than leaving the safety argued: if a source ever starts emitting them,
 * the test reddens here rather than the divergence arriving silently.
 *
 * 🪤 **"By construction" was an over-claim while the two halves each decided for
 * themselves.** An UNTRACKED symlink was a member — the snapshot dropped it and
 * the prune list handed it straight back — so this predicate's
 * `knownToExist: true` really could meet a dangling link. Nothing caught it,
 * because every symlink fixture in the suite was committed and a committed link
 * is exactly the one the snapshot half did drop.
 * `projection-untracked-symlink-extent.test.ts` is the untracked case, in both
 * untracked lanes.
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

  /**
   * This registration's {@link ContentDemand}, so the store key can separate on it.
   *
   * 🚨 Not decoration and not provenance: without it a `'deferred'` registration
   * and a keying one are **one question** to the reuse rule — same id, same
   * `null` parameter set — and the deriving run is served an extent that names
   * no content at all. `blobFactsCover` cannot catch that, because an extent
   * with no keyed rows gives it nothing to fail on. See
   * {@link ExtentContributor.registrationQuestion}.
   */
  readonly registrationQuestion: JsonValue;

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
    this.registrationQuestion = { contentDemand };
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
    const source = this.#sourceFor(base.root);
    const enumerated = await source.enumerate();

    const resources = new Map<string, ResourceRow>();
    const realizations: ResourceRealizationRow[] = [];
    const declined = declinedPathFilter(base.gitTracker, parameters);

    for (const { absolutePath, contentHint, shape } of enumerated) {
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
        // The run's single resolver, never one built here: it accumulates the
        // config conflicts it finds, and a per-extent instance would report one
        // authoring mistake once per extent that realizes the file.
        ...(base.mimeResolver !== undefined && { mimeResolver: base.mimeResolver }),
        // The registering LANE's policy, never a literal chosen here: paths
        // carry this extent's whole argument, and which lanes additionally need
        // the bytes is a fact about the lanes. See the class docstring.
        contentDemand: this.#contentDemand,
        ...(contentHint !== null && { contentHint }),
        // The enumerator's own answer to "what is this path", when it had one.
        // Passing it is what stops `collectRealization` opening with an `lstat`,
        // so the git source's constant-cost enumeration is no longer undone one
        // layer down. Absent for every path the walk found, which is why the two
        // sources now have genuinely different cost models rather than the same
        // one with different spawn counts.
        ...(shape !== null && { observedShape: shape }),
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
      // The gitignored directories the enumerator could not list. Not declined
      // with the rows beneath them: a lane that declines ignored rows still
      // needs to know where the enumeration stopped seeing, because "nothing
      // ignored beneath here" and "could not look beneath here" are different
      // claims and only the first is what `DECLINE_IGNORED` asserts.
      conditions: [
        ...source.unlistable.map((refusal) =>
          unlistableDirectoryCondition(refusal, base.root, extentId, base.identities.idFor(refusal.directory)),
        ),
        // Every link the enumerator declined, under the SAME decline this lane
        // applies to members: a lane that drops ignored rows drops ignored links
        // too. Decided against the finished realization set, so "the target is
        // realized" means realized in THIS extent.
        ...declinedSymlinkConditions(
          source.symlinks.filter((link) => !declined(link)),
          base.root,
          extentId,
          new Set(realizations.map((row) => row.path)),
          source.kind,
        ),
      ],
      // Classification tables, and this is an enumerator: it says where files
      // are, never what a `.claude/rules` file's `paths:` list reaches.
      claudeRulePatterns: [],
    };
  }
}

/**
 * `realization_conditions.code` for a gitignored directory the enumerator could
 * not list — the extent's own fact, recorded where a query and `validate` can
 * both read it. A warning, not an error: nothing beneath a gitignored directory
 * is in any lane's declared population, so the run's counts are not narrowed by
 * it; what is unknown is only whether ignored rows are missing.
 */
export const EXTENT_DIRECTORY_UNLISTABLE = 'EXTENT_DIRECTORY_UNLISTABLE';

/**
 * Render one refusal as the condition row that carries it.
 *
 * @param refusal - The directory the enumerator could not list
 * @param root - The corpus root the path is expressed against
 * @param extentId - This extent
 * @param resourceId - The identity of the directory itself, which IS realized
 * @returns The condition row
 */
function unlistableDirectoryCondition(
  refusal: DirectoryRefusal,
  root: string,
  extentId: string,
  resourceId: string,
): RealizationConditionRow {
  const path = toForwardSlash(safePath.relative(root, refusal.directory));
  const remedy = refusal.transient
    ? `${transientRefusalClause(refusal.code)}, so nothing is wrong with the tree — re-run before investigating anything.`
    : 'Fix the permissions on that directory if what is beneath it should be visible; nothing beneath a gitignored directory is in the validation population either way.';
  return {
    extentId,
    path,
    code: EXTENT_DIRECTORY_UNLISTABLE,
    severity: 'warning',
    message: `The gitignored directory '${path}' could not be listed (${refusal.code}), so nothing beneath it was enumerated; the directory itself is recorded and every readable sibling was enumerated. ${remedy}`,
    resourceId,
    ...CONDITION_WITHOUT_REFERENCE,
  };
}

/**
 * `realization_conditions.code` for a symbolic link the enumerator met and
 * declined to realize — see *"A SYMLINK IS NOT A MEMBER"* in `crawl-source.ts`.
 *
 * The policy is unchanged; what this closes is its SILENCE. Claude Code reads a
 * `link/CLAUDE.md` or a `.claude/rules/x.md` through the link, and with no row
 * at the link's path every size, chain, load and rules-pattern query omitted it
 * with nothing saying so. `info`, not `warning`: a link is an ordinary thing to
 * commit, and the row is the record that it was not counted, not a defect.
 *
 * ⚠️ Store-sound by construction. The row states the link's TARGET TEXT and
 * whether that target is realized in this same extent. A tracked or untracked-unignored link's
 * target text is its blob, so it is in the tree hash the store keys on; whether
 * the target is realized is a fact about this extent's own rows, which are
 * served together with it.
 *
 * ⚠️ The CODE is a fact about the HOST too: which of the three a link draws
 * is decided by where this host resolves it (see {@link hostResolution}), and a
 * link through a directory link or to a file outside the checkout resolves
 * wherever that host's filesystem says.
 *
 * ⚠️ One clause is a fact about the HOST, not about the tree, and always was:
 * the message asks the filesystem whether the link opens. It did so already for
 * the `EINVAL` arm ("not a symbolic link on disk", which a `core.symlinks=false`
 * checkout produces and a POSIX one never does), and it now does so for a target
 * whose spelling differs from the realized file's only in case or Unicode
 * normalization — `foo.md -> docs/Plain.md` beside `docs/plain.md` opens on
 * macOS and Windows and dangles on Linux. Both facts are constant for a given
 * checkout on a given machine, which is the scope a local store serves; a store
 * copied between hosts that fold differently would serve the other host's
 * answer. That is stated rather than guarded, because the alternative — deciding
 * case-folding from `process.platform` — is the *guard that returns the
 * reassuring value*: it would call the link realized on a case-SENSITIVE APFS
 * volume, where it is broken.
 */
export const EXTENT_SYMLINK_NOT_REALIZED = 'EXTENT_SYMLINK_NOT_REALIZED';

/**
 * `realization_conditions.code` for a declined link whose target resolves
 * OUTSIDE the corpus root — the same decline as
 * {@link EXTENT_SYMLINK_NOT_REALIZED}, carrying the one fact a consumer cannot
 * recover from it.
 *
 * ## Why a second CODE and not a second COLUMN
 *
 * Where a link points was already computed here and then spent entirely on
 * prose: {@link linkTarget} classifies the target lexically, and the verdict
 * survived only inside the row's `message`. Every consumer that needed it — the
 * `claude-rule-link-unchecked` built-in most of all, because Claude Code SKIPS
 * a rules file or directory reached through an out-of-root link
 * (`docs/external/claude-code-rules-paths-behaviour.md`, "Symlinked rules")
 * while loading an in-root one — would have had to parse that sentence, which
 * is the *"a contract carried in text"* drift class. `realization_conditions.code`
 * is an open vocabulary (`RealizationConditionRowSchema`) and a column is not:
 * a nullable column reaches 17 source files and the store's DDL to carry a fact
 * only links have.
 *
 * ⛔ The two codes are ONE concern and are always read through
 * {@link DECLINED_SYMLINK_CODES}. A consumer that filters on
 * `EXTENT_SYMLINK_NOT_REALIZED` alone silently drops every out-of-root link —
 * a string comparison typecheck cannot see, which is why the set is a constant
 * and not a literal at each site.
 *
 * ⛔ Decided by where the HOST resolves the link — `realpathSync.native`,
 * following every link on the way — against the root's own real path, because
 * that is what Claude Code decides by. It was lexical, and a lexical test called
 * `.claude/rules -> ../vendor/rules` in-root when `vendor` itself leaves the
 * root, and `chain.md -> hop.md` in-root when `hop.md` does: two rule sets the
 * harness skips, reported as in force. The target TEXT is used only to name an
 * in-root spelling in the message. A link that resolves nowhere takes this code
 * only when its text already leaves the root — Claude Code loads nothing through
 * it either way, and where it points is the fact the author can act on;
 * otherwise it is {@link EXTENT_SYMLINK_TARGET_UNRESOLVED}.
 */
export const EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT = 'EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT';

/**
 * `realization_conditions.code` for a declined link that resolves to NOTHING on
 * this host — dangling, a loop, or a path the OS refuses to resolve — while its
 * target text does not leave the root.
 *
 * ## Why a third code
 *
 * Neither sibling is true of it. {@link EXTENT_SYMLINK_NOT_REALIZED} is read by
 * `claude-rule-link-unchecked` as "Claude Code loads what the link reaches, so
 * the rule is in force and unchecked", and a dangling link reaches nothing:
 * Claude Code reads no rule through it. {@link EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT}
 * would say "outside the root" about a target spelled inside it. The consequence
 * a consumer needs — nothing is loaded through this link — is carried by the
 * code, never by the clause.
 *
 * ⚠️ A fact about the host, like the case-folding clause above: a link that
 * dangles here resolves on a checkout that has the target.
 */
export const EXTENT_SYMLINK_TARGET_UNRESOLVED = 'EXTENT_SYMLINK_TARGET_UNRESOLVED';

/**
 * Every `realization_conditions.code` a declined symbolic link is recorded
 * under — the ONE contract each consumer filters on.
 *
 * Declaration order is the order a reader meets them: the general decline
 * first, the out-of-root arm second, the resolves-nowhere arm third.
 */
export const DECLINED_SYMLINK_CODES = [
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
] as const;

/** One of the codes in {@link DECLINED_SYMLINK_CODES}. */
type DeclinedSymlinkCode = (typeof DECLINED_SYMLINK_CODES)[number];

/** Membership, precomputed — every consumer asks this rather than comparing strings. */
const DECLINED_SYMLINK_CODE_SET: ReadonlySet<string> = new Set(DECLINED_SYMLINK_CODES);

/**
 * Whether a condition row records a declined symbolic link.
 *
 * @param code - A `realization_conditions.code`
 * @returns True for any member of {@link DECLINED_SYMLINK_CODES}
 */
export function isDeclinedSymlinkCode(code: string): boolean {
  return DECLINED_SYMLINK_CODE_SET.has(code);
}

/** What every declined-link message says about the consequence, once. */
const NOT_COUNTED_CLAUSE =
  'VAT never realizes a symbolic link\'s own path, so no row in this projection is at that path:'
  + ' no size, Claude context chain or load, or claude_rule_patterns row counts it, although Claude Code'
  + ' reads a CLAUDE.md or rules file through a link.';

/**
 * One condition row per declined link.
 *
 * ⛔ Path-free apart from project-relative paths: an out-of-root target is
 * described, never named — its text can carry `$HOME` or any absolute path the
 * author's machine had — and the link's own path is always root-relative.
 *
 * @param links - Absolute, forward-slashed link paths the source declined
 * @param root - The corpus root every path is expressed against
 * @param extentId - This extent
 * @param realized - Root-relative paths this extent realized
 * @param recordedBy - Which source met the links — only git can record a link that is not one on disk
 * @returns The rows, in `links` order
 */
function declinedSymlinkConditions(
  links: readonly string[],
  root: string,
  extentId: string,
  realized: ReadonlySet<string>,
  recordedBy: CrawlSourceKind,
): RealizationConditionRow[] {
  if (links.length === 0) return [];
  // Once per extent, and only when there is a link to judge.
  const roots: LinkRoots = { root, realRoot: realRootOf(root) };
  return links.map((link) => {
    const path = toForwardSlash(safePath.relative(root, link));
    const { code, clause } = linkTarget(link, roots, realized, recordedBy);
    return {
      extentId,
      path,
      code,
      severity: 'info',
      message: `'${path}' is a symbolic link ${clause}. ${NOT_COUNTED_CLAUSE}`,
      resourceId: null,
      ...CONDITION_WITHOUT_REFERENCE,
    };
  });
}

/** Where one link points: the code that carries the verdict, and the prose that states it. */
interface LinkTargetVerdict {
  /** The row's `realization_conditions.code` — one of {@link DECLINED_SYMLINK_CODES}. */
  readonly code: DeclinedSymlinkCode;
  /** The clause that follows "is a symbolic link". */
  readonly clause: string;
}

/**
 * Where one link points, said without leaking anything outside the root.
 *
 * ⛔ The CODE is the carrier and the clause is the rendering, never the other
 * way round: a consumer that needed "is this target outside the root?" used to
 * have to find the sentence below in `message`, and one reworded clause would
 * have changed a check's behaviour with no test able to see it.
 *
 * ⛔ The code comes from {@link hostResolution} alone — one containment
 * predicate, not a lexical one beside a real one. The target TEXT is read only
 * to name an in-root spelling, and to place a link that resolves nowhere.
 *
 * @param link - Absolute, forward-slashed link path
 * @param roots - The root, as enumerated and as resolved
 * @param realized - Root-relative paths this extent realized
 * @param recordedBy - Which source met the link
 * @returns The row's code and the clause that follows "is a symbolic link"
 */
function linkTarget(
  link: string,
  roots: LinkRoots,
  realized: ReadonlySet<string>,
  recordedBy: CrawlSourceKind,
): LinkTargetVerdict {
  const host = hostResolution(link, roots.realRoot);
  let target: string;
  try {
    target = readlinkSync(link);
  } catch (error) {
    // Gone or unreadable between the enumeration and here: still a declined
    // link, still recorded — only its target text is unknown. A bug is not that.
    if (!isFilesystemAccessError(error)) throw error;
    return { code: unnamedTargetCode(host), clause: unreadableTargetClause(error, recordedBy) };
  }
  // A target absolute on SOME platform but not this one — `C:/…` or a UNC
  // `\\host\share\…` committed from Windows, read on POSIX — would resolve here
  // as a relative name under the link's directory and be quoted in full. It
  // names a place outside any root this host can see.
  const foreignAbsolute = isAbsoluteAnyPlatform(target) && !isAbsolute(target);
  const named = foreignAbsolute ? undefined : inRootRelative(roots, safePath.resolve(link, '..', target));
  switch (host.kind) {
    case 'inside': {
      return { code: EXTENT_SYMLINK_NOT_REALIZED, clause: insideClause(named ?? host.path, host.path, roots, realized) };
    }
    case 'outside': {
      return { code: EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT, clause: escapingClause(named) };
    }
    case 'nowhere': {
      return named === undefined
        ? { code: EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT, clause: OUTSIDE_UNNAMED_CLAUSE }
        : { code: EXTENT_SYMLINK_TARGET_UNRESOLVED, clause: unresolvedClause(named) };
    }
  }
}

/**
 * The root as the enumeration spelled it, and as the host resolves it.
 *
 * ⛔ Two spellings of ONE directory, each compared only with its own kind: the
 * target TEXT resolves against the enumerated spelling, a `realpathSync.native`
 * answer against the real one. Comparing a real path with an unresolved root —
 * a root handed over through a link, macOS `/var` for `/private/var`, a root
 * spelled in the wrong case — read every physical target as outside it.
 */
interface LinkRoots {
  /** The corpus root as the enumeration spelled it — every row path is relative to this. */
  readonly root: string;
  /** Its real path, resolved once per extent. */
  readonly realRoot: string;
}

/**
 * The root's real path, or its own spelling when the host will not resolve it.
 *
 * @param root - The corpus root
 * @returns Absolute, forward-slashed
 */
function realRootOf(root: string): string {
  try {
    return toForwardSlash(realpathSync.native(root));
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    return root;
  }
}

/** Where the host says one link leads, following every link on the way. */
type HostResolution =
  /** Inside the root, at this root-relative real path (`''` for the root itself). */
  | { readonly kind: 'inside'; readonly path: string }
  /** Somewhere outside the root — never named. */
  | { readonly kind: 'outside' }
  /** Nowhere: dangling, a loop, or refused. */
  | { readonly kind: 'nowhere' };

/**
 * Where the host resolves one link — the ONE containment predicate every code
 * is chosen by.
 *
 * `realpathSync.native` rather than `realpathSync`: only the native call returns
 * the canonical on-disk spelling, which {@link linkTargetRealization} needs.
 *
 * @param link - Absolute, forward-slashed link path
 * @param realRoot - The root's real path
 * @returns The resolution
 */
function hostResolution(link: string, realRoot: string): HostResolution {
  let real: string;
  try {
    real = toForwardSlash(realpathSync.native(link));
  } catch (error) {
    // Dangling, looping or unreadable: the host reaches nothing, which is an
    // answer rather than a bug. Anything that is not a filesystem refusal is.
    if (!isFilesystemAccessError(error)) throw error;
    return { kind: 'nowhere' };
  }
  const relative = toForwardSlash(safePath.relative(realRoot, real));
  return relativeEscapesRoot(relative) ? { kind: 'outside' } : { kind: 'inside', path: relative };
}

/**
 * The code for a link whose target text could not be read — the host's verdict
 * alone. Resolving nowhere is {@link EXTENT_SYMLINK_TARGET_UNRESOLVED}: nothing
 * was read, so nothing places the target outside the root.
 *
 * @param host - Where the host resolves the link
 * @returns The row's code
 */
function unnamedTargetCode(host: HostResolution): DeclinedSymlinkCode {
  switch (host.kind) {
    case 'inside': {
      return EXTENT_SYMLINK_NOT_REALIZED;
    }
    case 'outside': {
      return EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT;
    }
    case 'nowhere': {
      return EXTENT_SYMLINK_TARGET_UNRESOLVED;
    }
  }
}

/** The out-of-root clause when nothing in-root can be named. */
const OUTSIDE_UNNAMED_CLAUSE =
  'whose target lies outside the project root (not named here), so it is realized nowhere in this projection';

/**
 * The clause for a link the host resolves outside the root.
 *
 * @param named - The target text's in-root spelling, when it has one
 * @returns The clause
 */
function escapingClause(named: string | undefined): string {
  if (named === undefined || named === '') return OUTSIDE_UNNAMED_CLAUSE;
  return `to ${quotedPath(named)}, which resolves outside the project root through a linked path (the`
    + ' real target is not named here), so it is realized nowhere in this projection';
}

/**
 * The clause for a link whose in-root target resolves to nothing on this host.
 *
 * @param named - The target text's in-root spelling
 * @returns The clause
 */
function unresolvedClause(named: string): string {
  const where = named === '' ? 'to the project root' : `to ${quotedPath(named)}`;
  return `${where}, which resolves to nothing on this host — it does not exist, is a link loop, or`
    + ' cannot be resolved — so nothing is read through the link and it is realized nowhere in this projection';
}

/**
 * The clause for a link the host resolves inside the root.
 *
 * @param named - The in-root spelling to name — the target text's, or the
 *   host's own path when the text cannot be placed in-root
 * @param real - The host's root-relative resolution
 * @param roots - The root, as enumerated and as resolved
 * @param realized - Root-relative paths this extent realized
 * @returns The clause
 */
function insideClause(named: string, real: string, roots: LinkRoots, realized: ReadonlySet<string>): string {
  if (named === '') return 'to the project root itself';
  return `to ${quotedPath(named)}, ${realizationClause(linkTargetRealization(
    named,
    realized,
    () => real,
    () => isSymbolicLink(safePath.resolve(roots.root, named)),
  ))}`;
}

/**
 * Whether a path is itself a symbolic link, by `lstat`.
 *
 * @param absolutePath - The path to ask about
 * @returns True for a link; a path the host will not `lstat` answers true too,
 *   so it can never be accepted as a respelling of a realized file
 */
function isSymbolicLink(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isSymbolicLink();
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    return true;
  }
}

/**
 * What the message says when `readlink` refused the path.
 *
 * ⚠️ Never the out-of-root arm: nothing was read, so nothing is known about
 * where the link points, and a code that said "outside the root" here would be
 * a guess the reader cannot check.
 *
 * @param error - The filesystem access error `readlinkSync` threw
 * @param recordedBy - Which source met the link
 * @returns The clause that follows "is a symbolic link"
 */
function unreadableTargetClause(error: unknown, recordedBy: CrawlSourceKind): string {
  // EINVAL: the path is not a link on disk. From git that is a stable fact —
  // the index says mode 120000 and the working tree holds a plain file, a
  // checkout with `core.symlinks=false` (the Windows default without
  // Developer Mode). From the walk it can only mean the link was replaced
  // since it was listed, and git is not involved.
  if ((error as { code?: unknown }).code === 'EINVAL') {
    return recordedBy === 'git'
      ? 'in git that is not a symbolic link on disk (a checkout with core.symlinks=false writes it as a plain file holding the target text)'
      : 'that is no longer a symbolic link on disk';
  }
  return 'whose target could not be read';
}

/**
 * What one link's target realization says, after "to '<target>', ".
 *
 * @param realization - The verdict {@link linkTargetRealization} reached
 * @returns The clause
 */
function realizationClause(realization: LinkTargetRealization): string {
  switch (realization.kind) {
    case 'realized': {
      return 'which is realized at its own path';
    }
    case 'realized-as': {
      return `which this host's filesystem resolves to ${quotedPath(realization.path)} — the two`
        + ' spellings differ only in case or Unicode normalization, so the link opens here and'
        + ` breaks on a byte-exact filesystem; it is realized at ${quotedPath(realization.path)}`;
    }
    case 'unrealized': {
      // The host resolved this link inside the root, so the target exists — a
      // link that resolves nowhere never reaches this clause.
      return 'which is not realized in this projection either — it is gitignored, is excluded from'
        + ' the crawl, or is itself a link';
    }
  }
}

/**
 * Whether a link's target reaches a realized row — *on this host*.
 *
 * ## 🪤 The byte-exact lookup this replaced was wrong on two of the three OSes
 *
 * `realized.has(target)` asks the set for the author's spelling. On macOS and
 * Windows `cased.md -> docs/Plain.md` beside a realized `docs/plain.md` opens
 * perfectly and was reported *"not realized … it does not exist"* — a claim the
 * reader can disprove by opening the link, and the kind of false absence that
 * teaches an adopter to ignore the row.
 *
 * ⛔ The host answers, and nothing here re-implements case folding: `realPathOf`
 * is the filesystem's own resolution (`realpathSync.native`, which returns the
 * canonical on-disk spelling). A folding table of VAT's own would be a second
 * matcher free to disagree with the filesystem it is describing, and it would
 * have to guess whether *this* volume folds — a case-sensitive APFS volume and a
 * case-insensitive Linux mount both exist.
 *
 * ⚠️ The resolution is accepted ONLY as a respelling of the named target. A link
 * chain can resolve to an entirely different file, and calling the named target
 * realized on that evidence would be a lie about the path the message quotes.
 *
 * 🪤 **A chain can also resolve to a case variant.** On a case-SENSITIVE
 * volume, `a.md -> docs/Plain.md` where `docs/Plain.md` is its own link to the
 * realized `docs/plain.md` resolves to a respelling of the target — and the
 * target is a link, not a folded spelling of the file: the link opens on a
 * byte-exact filesystem too. So the respelling is accepted only when the named
 * target is not itself a link.
 *
 * @param target - The link's target, root-relative and forward-slashed
 * @param realized - Root-relative paths this extent realized
 * @param realPathOf - The host's resolution of the link, root-relative, or
 *   undefined when it resolves nowhere inside the root
 * @param targetIsLink - Whether the named target is itself a symbolic link on
 *   this host; asked only when a respelling is about to be accepted
 * @returns Which of the three answers holds
 */
export function linkTargetRealization(
  target: string,
  realized: ReadonlySet<string>,
  realPathOf: () => string | undefined,
  targetIsLink: () => boolean,
): LinkTargetRealization {
  if (realized.has(target)) return { kind: 'realized' };
  const real = realPathOf();
  if (real === undefined || real === target || !realized.has(real)) return { kind: 'unrealized' };
  return foldedKey(real) === foldedKey(target) && !targetIsLink()
    ? { kind: 'realized-as', path: real }
    : { kind: 'unrealized' };
}

/**
 * The comparison key two spellings of one filename share.
 *
 * NFC first, then case: a name can differ in both at once, and folding case
 * alone would miss the composed/decomposed pair macOS also matches. ⛔ A key,
 * never a path to open — the same prohibition `toNfc` carries.
 *
 * @param path - A root-relative, forward-slashed path
 * @returns Its folded comparison key
 */
function foldedKey(path: string): string {
  return toNfc(path).toLowerCase();
}

/** The three answers {@link linkTargetRealization} can reach. */
type LinkTargetRealization =
  /** The target is realized under the spelling the link wrote. */
  | { readonly kind: 'realized' }
  /** The host resolves the target to a realized file spelled differently. */
  | { readonly kind: 'realized-as'; readonly path: string }
  /** Nothing this extent realized is reachable through the link. */
  | { readonly kind: 'unrealized' };

/**
 * A link target TEXT's in-root spelling, or undefined when it cannot be placed
 * inside the root — used to NAME a target, never to choose a code (that is
 * {@link hostResolution}'s alone).
 *
 * An absolute target can name an in-root file through a linked prefix — macOS
 * spells the temp root `/var/…` and its real path `/private/var/…` — so a
 * target that escapes lexically is asked again with its parent directory
 * resolved, and compared with the REAL root: a real path set beside an
 * unresolved root escapes it whatever it names. Only the escaping case pays for
 * the syscall, and an outside target is never named.
 *
 * @param roots - The root, as enumerated and as resolved
 * @param resolved - The target, resolved against the link's directory
 * @returns Root-relative, forward-slashed; `''` for the root itself
 */
function inRootRelative(roots: LinkRoots, resolved: string): string | undefined {
  const lexical = toForwardSlash(safePath.relative(roots.root, resolved));
  if (!relativeEscapesRoot(lexical)) return lexical;
  let parent: string;
  try {
    // An absent parent comes back as its own spelling, which still escapes.
    parent = normalizePath(safePath.resolve(resolved, '..'));
  } catch (error) {
    // A directory the OS will not resolve: it cannot be shown to be inside
    // the root, so it is reported as outside, and never named.
    if (!isFilesystemAccessError(error)) throw error;
    return undefined;
  }
  const real = toForwardSlash(safePath.relative(roots.realRoot, safePath.join(parent, basename(resolved))));
  return relativeEscapesRoot(real) ? undefined : real;
}

/**
 * A root-relative path quoted for a one-line message: single quotes, with any
 * control character escaped the way JSON escapes it — a newline in a link
 * target is legal on POSIX, and written raw it would split the report.
 *
 * @param path - Root-relative path
 * @returns The quoted form
 */
function quotedPath(path: string): string {
  return `'${JSON.stringify(path).slice(1, -1)}'`;
}

/**
 * Whether a stored {@link EXTENT_DIRECTORY_UNLISTABLE} row is still true of
 * the tree — the directory exists and still refuses to be listed.
 *
 * 🪤 The store key cannot answer this. It is the tree hash plus the ambient
 * inputs, and the tree hash is `git add --all` over NON-IGNORED content: the
 * permission bit on a gitignored directory is in no tree object, so a run that
 * met `build/locked` at `chmod 000` and a run after `chmod 755` share a key.
 * The served row then says the directory could not be listed while it lists
 * perfectly, and the rows beneath it — enumerated around the gap — are missing
 * from the served population with no finding. The driver asks this of every
 * such row on a hit and treats a `false` as a miss; the cost is one `readdir`
 * attempt per ROW, and a row is by nature rare.
 *
 * A directory that is GONE also answers `false`: a row about a directory that
 * no longer exists is not a true row, and the population beneath it changed.
 * The opposite drift — locked AFTER caching — is the pre-existing staleness of
 * every ignored row and is not addressed here.
 *
 * @param row - A `realization_conditions` row carrying this code
 * @param root - The corpus root the row's path is relative to
 * @returns True when the directory still exists and still refuses a listing
 */
export function unlistableRowStillHolds(row: RealizationConditionRow, root: string): boolean {
  const directory = safePath.resolve(root, row.path);
  if (!existsSync(directory)) return false;
  try {
    readdirSync(directory);
    return false;
  } catch (error) {
    // Gone between the `existsSync` and the listing: not a true row either.
    // Anything else — EACCES, ELOOP, a dead mount — is the refusal the row
    // records, still refusing.
    return !isPathAbsentError(error);
  }
}
