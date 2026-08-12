/**
 * Pure link graph walker that operates on ResourceRegistry data.
 *
 * Replaces the I/O-heavy `collectLinks()` with a pure function that walks
 * the link graph using pre-parsed data from a ResourceRegistry. This eliminates
 * per-file `parseMarkdown()` calls and `existsSync()` checks for markdown files.
 *
 * Non-markdown assets (images, JSON, etc.) won't be in the registry and still
 * require `existsSync()` checks — this is acceptable since the goal is eliminating
 * redundant I/O for markdown files that are already parsed.
 *
 * ## Membership is not traversability
 *
 * A registry MEMBER is a file VAT has parsed: its links are known, so the
 * packager's rewriter can reach inside it and repoint them at bundled copies. A
 * ROUTABLE file is one the walker walks THROUGH — it enqueues that file's link
 * targets as further bundle members. Routing is markdown-only
 * ({@link isRoutable}); HTML is "a leaf we can read, not a door we walk
 * through".
 *
 * These used to be the same thing, by accident: any link target that
 * `getResourceById` found was queued, so a registry's include globs silently
 * WERE the routability policy. The two production registries disagreed as a
 * result. `crawlAndResolveRegistry` includes HTML, so `vat audit` and
 * post-build validation walked THROUGH a bundled page and counted its targets
 * as bundled; the packager's `createProjectRegistry` is markdown-only, so at
 * walk time the same page was an opaque asset and its targets were dropped.
 * Same tree, two answers to "is HTML a door" — and audit's answer described a
 * bundle the build never produced.
 *
 * Links out of a non-routable member are not silently dropped: each one whose
 * target the walk never bundled by some other route is reported as a
 * `non-routable-source` exclusion (`LINK_FROM_NON_ROUTABLE_FILE`).
 */

import { basename, dirname } from 'node:path';

import { isLocalFileLink, parserKindForPath, resolveLocalHref } from '@vibe-agent-toolkit/resources';
import type { DeferredArtifacts, ResourceLink, ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { FsLookupCache, type GitTracker, isGitIgnored, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { isAgentInstructionBasename, isNavigationBasename } from './validators/validation-rules.js';

/**
 * Resolution result for a single link found in a bundled markdown file.
 */
export interface LinkResolution {
  /** Absolute path to the linked file (the link TARGET) */
  path: string;
  /**
   * Absolute path to the file that CONTAINS the link.
   *
   * Distinct from {@link LinkResolution.path} on purpose: for a
   * `missing-target` exclusion the target does not exist, so an issue
   * anchored to it names a file the author cannot open. The issue's
   * `location` must be this, the containing file.
   */
  sourcePath: string;
  /** 1-based line of the link within {@link LinkResolution.sourcePath}, when known */
  sourceLine?: number | undefined;
  /**
   * Whether the link TARGET existed on disk when the walker classified it.
   *
   * Recorded rather than re-derived downstream. The verdict engine gates
   * `LINK_TO_GITIGNORED_FILE` on "gitignored AND exists at source"; a
   * translation front-end that hardcodes existence turns that guard into dead
   * code, so the one place that actually stat'ed the path carries the answer.
   */
  targetExists: boolean;
  /** Whether the file will be bundled */
  bundled: boolean;
  /** Reason it was excluded (only set when bundled is false) */
  excludeReason?: 'depth-exceeded' | 'pattern-matched' | 'directory-target' | 'outside-project' | 'navigation-file' | 'agent-instruction-file' | 'skill-definition' | 'gitignored' | 'missing-target' | 'unreadable-target' | 'non-routable-source' | undefined;
  /** The rule that matched (only set for pattern-matched exclusions) */
  matchedRule?: ExcludeRule | undefined;
  /** Link text from the source markdown */
  linkText?: string | undefined;
  /** Original href from the markdown */
  linkHref?: string | undefined;
}

/**
 * A rule that excludes files from bundling based on glob patterns.
 * First matching rule wins (ordered evaluation).
 */
export interface ExcludeRule {
  patterns: string[];
  template?: string | undefined;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal interface for the registry operations walkLinkGraph needs.
 * Avoids tight coupling to the full ResourceRegistry class.
 */
export interface WalkableRegistry {
  getResourceById(id: string): ResourceMetadata | undefined;
  getResource(filePath: string): ResourceMetadata | undefined;
}

/**
 * Result of walking the link graph from a skill resource.
 */
export interface LinkGraphResult {
  /** Markdown resources within depth and not excluded */
  bundledResources: ResourceMetadata[];
  /** Non-markdown file paths (images, JSON, etc.) — absolute paths */
  bundledAssets: string[];
  /** References detected but NOT bundled (depth, exclude, etc.) */
  excludedReferences: LinkResolution[];
  /** Actual max depth of the bundled portion */
  maxBundledDepth: number;
  /** Asset paths that are deferred (declared in files config, may not exist yet) */
  deferredAssets: string[];
}

/**
 * Options for walking the link graph.
 */
export interface WalkLinkGraphOptions {
  /** Max depth for following markdown links (Infinity for 'full') */
  maxDepth: number;
  /** Ordered exclude rules (first match wins) */
  excludeRules: ExcludeRule[];
  /** Project root for boundary enforcement and pattern matching */
  projectRoot: string;
  /**
   * Absolute path to the current skill's SKILL.md. Used to distinguish self-links
   * (a bundled doc linking back to the current skill's own SKILL.md) from
   * cross-skill links to other skills' SKILL.md files. Self-links are silently
   * ignored; cross-skill links become `skill-definition` exclusions.
   */
  skillRootPath: string;
  /** Whether to exclude navigation files (README.md, index.md, etc.) */
  excludeNavigationFiles?: boolean;
  /**
   * Declared `files:` deferred-artifact model. A path covered by it is treated
   * as a deferred build artifact in two cases:
   *
   * - The target does not yet exist on disk ({@link checkDeferred}, the FIRST
   *   discriminator in {@link classifyExclusion}) — covered via dest OR source.
   * - The target exists, is gitignored, AND is covered as a DEST (the
   *   gitignore branch, {@link classifyGitignored}) — the expected state of a
   *   build artifact once a build has run, not a leak. Source-only coverage
   *   does NOT exempt an existing, gitignored target: a `files:` source is a
   *   real file the author pointed at, and the leak signal is wanted.
   *
   * A covered path that exists and is NOT gitignored still falls through to
   * the normal directory-target / bundling handling. An UNCOVERED path is
   * never exempted — an existing gitignored file outside `files:` still
   * surfaces the `gitignored` leak signal.
   */
  deferredArtifacts?: DeferredArtifacts;
  /**
   * Optional pre-populated {@link GitTracker} for O(1) gitignore checks.
   *
   * When provided, link-target gitignore checks use the tracker's active set,
   * which avoids spawning `git check-ignore` per file. Supply the same
   * tracker you already built for the containing scan (e.g. from audit's
   * ScanContext) so the first call warms the cache and every subsequent
   * walker call answers in O(1).
   *
   * When omitted, the walker falls back to the legacy per-path
   * `isGitIgnored()` spawn so one-off callers continue to work unchanged.
   */
  gitTracker?: GitTracker;
  /**
   * Optional {@link FsLookupCache} to answer this walk's `exists`/`isDirectory`
   * questions (pass 1′). Omitted, the walk builds its own and discards it.
   *
   * ⚠️ **Only inject one when nothing writes to the tree between the walks that
   * share it.** The cache holds a snapshot, so a probe taken before a build
   * step answers questions asked after it. `packageSkill` writes `dist/` per
   * skill and therefore must NOT share a probe across skills. Provided mainly
   * so callers can read {@link FsLookupCache.probeStats} back.
   */
  pathProbe?: FsLookupCache;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Resolve an anchor-free link href to an absolute file path.
 *
 * Delegates to `resolveLocalHref` — the ONE resolver for "what file does this
 * href name", already used by the resources lane — rather than restating the
 * rule. This used to be `resolve(dirname(sourceFilePath), href)`, which is
 * correct only for relative references: `path.resolve` DISCARDS its base when
 * the second argument is absolute, so an RFC 3986 §4.2 absolute-path reference
 * (`/docs/guide.md`, which means project-root-relative) came back as the
 * FILESYSTEM-root path `/docs/guide.md` and was then classified outside every
 * project root but `/`. The two lanes gave two answers for one link: the
 * resources lane resolved it and found the file, this lane reported
 * `LINK_OUTSIDE_PROJECT` at error severity against a target that exists and is
 * in the registry.
 *
 * A root-absolute href that genuinely escapes the project root is still
 * resolved against the project root here, so the boundary decision stays in the
 * single `isOutsideProject` check below instead of being made twice.
 */
function resolveHrefToPath(hrefWithoutAnchor: string, sourceFilePath: string, projectRoot: string): string {
  const resolution = resolveLocalHref(hrefWithoutAnchor, sourceFilePath, projectRoot);
  if (resolution.kind === 'resolved') {
    return resolution.resolvedPath;
  }
  return hrefWithoutAnchor.startsWith('/')
    ? safePath.resolve(projectRoot, hrefWithoutAnchor.slice(1))
    : safePath.resolve(dirname(sourceFilePath), hrefWithoutAnchor);
}

/** Check if a link targets a file outside the project boundary */
function isOutsideProject(targetPath: string, projectRoot: string): boolean {
  return safePath.relative(projectRoot, targetPath).startsWith('..');
}

// Navigation / agent-instruction classification is the shared, case-insensitive
// matcher from validation-rules (`isNavigationBasename` / `isAgentInstructionBasename`),
// used directly at the call sites below. On APFS/NTFS a `Claude.md` is loaded as
// instructions exactly as a `CLAUDE.md` is, so the walker must refuse both spellings.

/** Create an exclusion record */
function makeExclusion(
  targetPath: string,
  sourcePath: string,
  targetExists: boolean,
  reason: LinkResolution['excludeReason'],
  link: ResourceLink,
  matchedRule?: ExcludeRule,
): LinkResolution {
  return {
    path: targetPath,
    sourcePath,
    ...(link.line !== undefined && { sourceLine: link.line }),
    targetExists,
    bundled: false,
    excludeReason: reason,
    ...(matchedRule ? { matchedRule } : {}),
    linkText: link.text,
    linkHref: link.href,
  };
}

// ============================================================================
// Internal: Link classification during graph walk
// ============================================================================

/** Mutable state accumulated during the graph walk */
interface WalkState {
  visitedResourceIds: Set<string>;
  bundledResourceMap: Map<string, ResourceMetadata>;
  bundledAssetSet: Set<string>;
  deferredAssetSet: Set<string>;
  excludedReferences: LinkResolution[];
  maxBundledDepth: number;
  queue: Array<[ResourceMetadata, number]>;
  /**
   * Candidate `non-routable-source` exclusions, held back until the walk ends.
   *
   * A link out of a non-routable member may point at something the walk bundles
   * anyway by a markdown route — reporting it the moment it is seen would make
   * the finding depend on queue order. Filtering at the end against the final
   * bundled sets makes it order-independent: only genuinely un-bundled targets
   * survive into {@link WalkState.excludedReferences}.
   */
  unfollowedFromNonRoutable: LinkResolution[];
  /**
   * Pass 1′ — the attribute oracle for the paths this walk asks about.
   *
   * Link targets are not in the enumeration by construction: they are
   * discovered by parsing, so their `exists`/`isDirectory` attributes have to
   * be filled after the fact. Filling them once per distinct path, rather than
   * once per link, is the whole of the change — several documents linking the
   * same README asked the same two syscalls that many times.
   *
   * **Scoped to one walk, deliberately.** `packageSkill` writes into `dist/`
   * between skills, so a probe shared across skills would answer a
   * post-build question from a pre-build snapshot — exactly the staleness
   * {@link FsLookupCache}'s own docs warn about.
   *
   * That scoping costs most of the collapse on the packager lane, and the
   * trade is worth stating rather than rediscovering. Measured on VAT's own
   * tree, 2026-08-09: `vat audit .` asks 42 questions over 9 distinct targets
   * (4.7×, because one walk revisits the same shared docs), while
   * `vat skills build` asks 26 over 24 — 13 skills, one probe each, and
   * targets almost never repeat inside a single skill's walk. Sharing one
   * probe across skills would collapse that too, and would be wrong.
   * Correctness wins; the lane simply does not have the redundancy.
   */
  pathProbe: FsLookupCache;
  /**
   * Pass 1′ — memoized gitignore answers, one per distinct link target asked
   * about.
   *
   * Separate from {@link WalkState.pathProbe} because the oracle is not a
   * filesystem lookup and utils must not learn about git; separate from the
   * {@link PathFacts} row because that row is rebuilt per ask (see its docs).
   * Sparse by design: only targets that reach the cascade's last branch appear.
   */
  gitignoreFacts: Map<string, boolean>;
}

/** Compiled exclude matcher (pattern + original rule) */
interface ExcludeMatcher {
  rule: ExcludeRule;
  isMatch: (path: string) => boolean;
}

/**
 * Pass 1′ — the filled attribute row for one link target.
 *
 * Link targets are outside the enumeration by construction (they are discovered
 * by parsing), so their attributes are filled after parse rather than during
 * it. One row per distinct path; {@link classifyExclusion} then reads columns
 * instead of touching the filesystem.
 *
 * ## The three columns are not the whole row — `gitignored` is deliberately not here
 *
 * `exists`, `isDirectory` and `insideProject` are unconditional and cheap: the
 * first two come from {@link FsLookupCache.probe}, which every target pays for
 * anyway and which memoizes them across links; the third is pure path math.
 *
 * `gitignored` is neither, so it is read through {@link readGitignored} at the
 * point the cascade reaches it. The oracle behind it is a `git check-ignore`
 * **subprocess** whenever no {@link GitTracker} was plumbed through (which is
 * the case for `extract-skill`'s lane), and the cascade reaches it only for
 * targets that survive all seven earlier discriminators. Filling it for every
 * row would spawn a process per directory target, per README, per
 * pattern-excluded path — paths asked about today only because they were never
 * asked about at all. Demand-reading keeps the *set of paths asked* identical
 * to the shipped behaviour, which is what lets this refactor claim
 * byte-identical output.
 *
 * ## Built per ask, not memoized — on purpose
 *
 * Storing the row would shadow the probe's own memo and silently zero out
 * {@link FsLookupCache.probeStats}, the one observable that dies when the probe
 * memo dies. Each layer keeps its own counted memo instead: the probe counts
 * syscalls avoided, {@link WalkState.gitignoreFacts} collapses oracle calls.
 *
 * Rebuilding the row costs one `safePath.relative` per ask — pure string math
 * on two absolute paths, no syscall. **That is a small net ADDITION, not
 * parity:** the shipped cascade evaluated `isOutsideProject` at position 4, so
 * it never ran for a deferred target, an existing directory, or a
 * present-but-unstattable path. Filling the column unconditionally is the price
 * of the row being a row, and it is stated here rather than dressed up as
 * break-even.
 */
interface PathFacts {
  /** `existsSync` — follows symlinks, so a dangling link reads as absent. */
  readonly exists: boolean;
  /**
   * `statSync().isDirectory()`, or `null` for *no answer* — the path is absent,
   * or it is present and `statSync` threw anyway. See
   * {@link FsLookupCache.probe}.
   */
  readonly isDirectory: boolean | null;
  /** Pure path math: does the target resolve inside `projectRoot`? */
  readonly insideProject: boolean;
}

/**
 * Build the pass-1′ row for one link target.
 *
 * The two syscalls come from {@link FsLookupCache.probe}, which memoizes them
 * across links, so repeated calls for the same path are free of I/O.
 */
function fillPathFacts(targetPath: string, options: WalkLinkGraphOptions, state: WalkState): PathFacts {
  const { exists, isDirectory } = state.pathProbe.probe(targetPath);
  return {
    exists,
    isDirectory,
    insideProject: !isOutsideProject(targetPath, options.projectRoot),
  };
}

/**
 * What the classifier decided about a target, as a value rather than as a
 * mutation.
 *
 * Splitting the verdict from the recording is what lets the cascade be a pure
 * function of {@link PathFacts}: every branch used to push into
 * `excludedReferences` or `deferredAssetSet` on its way out, which made the
 * classifier untestable without a filesystem and a walk state.
 */
type ExclusionVerdict =
  /** A `files:`-covered build artifact — recorded in the deferred set, not as an exclusion. */
  | { readonly kind: 'deferred' }
  /** An exclusion to record against the link. */
  | { readonly kind: 'excluded'; readonly reason: NonNullable<LinkResolution['excludeReason']>; readonly matchedRule?: ExcludeRule }
  /** Stop classifying and record nothing at all. */
  | { readonly kind: 'skipped' };

/**
 * Check if a target path is a not-yet-materialized deferred build artifact.
 * Must run BEFORE any directory check to avoid classifying a missing path.
 *
 * This check is gated on the target NOT existing on disk: it classifies the
 * "hasn't been built yet" half of the deferred-artifact lifecycle. An
 * existing real file at a covered files: dest (or source) is NOT deferred by
 * THIS check — it falls through to the directory-target check and beyond.
 * The gitignore branch further down ({@link classifyGitignored}) carries its
 * OWN, unconditional `deferredArtifacts` exemption (existing or not) for the
 * "already built, and gitignored as expected" half — see the comment there.
 * So an existing-but-gitignored covered path still ends up classified as
 * deferred, just via that branch rather than this one; only an
 * existing-and-NOT-gitignored covered path (or an uncovered path) reaches
 * normal handling. {@link DeferredArtifacts.covers} does the exact-OR-
 * directory-prefix membership test (pure, no filesystem access); the
 * existence answer comes from the target's pass-1′ row.
 *
 * @returns true if the path was classified as deferred
 */
function checkDeferred(
  targetPath: string,
  targetExists: boolean,
  deferredArtifacts: DeferredArtifacts,
): boolean {
  return deferredArtifacts.covers(targetPath) && !targetExists;
}

/**
 * Does the walker refuse to bundle this target because it is a repo-internal
 * agent-instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)?
 *
 * These cannot normally travel in a bundle: they describe the repository they
 * live in, they collide on basename across packages, and a project-locally
 * installed skill puts them where Claude Code will load them as instructions.
 * Deliberately NOT gated on `excludeNavigationFiles` — that knob is about content
 * granularity, a different question from "this file is not distributable".
 *
 * The escape hatch is an EXPLICIT `skills.config.<name>.files` entry naming the
 * file, and it is honoured HERE rather than "bypassing the walker". It was
 * documented as a bypass and was not one: the walker refused the LINK whatever the
 * config said, so an author who declared the file got it shipped, got the link to
 * it silently stripped from the packaged content, and STILL got a build-failing
 * error whose own remedy was the thing they had already done. Honouring the
 * declaration here is what makes that remedy real — the file is bundled,
 * `applyFilesEntriesToPathMap` re-points it at the declared dest, and the
 * rewritten link resolves to it.
 *
 * "Explicit" is EXACT membership in {@link DeferredArtifacts.sourcePaths},
 * deliberately NOT the directory-prefix test {@link DeferredArtifacts.covers}
 * performs. That set registers a GLOB entry by its STATIC BASE — a directory — so
 * a glob's matches are only ever prefix CHILDREN of what is in the set, while an
 * explicit `source: notes/CLAUDE.md` is in it verbatim. Exact equality is
 * therefore precisely the explicit-vs-glob discriminator, and reusing the
 * already-plumbed `deferredArtifacts` avoids standing up a second model of the
 * same `files:` config for one lane to drift away from.
 *
 * That distinction is load-bearing: naming a file is an unambiguous instruction to
 * ship it, whereas a glob is a net, not a declaration — it never named the file it
 * caught and so does not get to launder the exemption an explicit declaration
 * earns. `partitionNeverPackaged` in files-config.ts draws the same line on the
 * copy side; both must agree or the two mechanisms disagree about one bundle.
 */
function refusesAgentInstructionFile(targetPath: string, options: WalkLinkGraphOptions): boolean {
  if (!isAgentInstructionBasename(basename(targetPath))) return false;
  const declaredSources = options.deferredArtifacts?.sourcePaths;
  if (declaredSources === undefined) return true;
  return !declaredSources.has(toForwardSlash(safePath.relative(options.projectRoot, targetPath)));
}

/**
 * Classify a target already known to be gitignored as either a leak or an
 * exempted `files:` build artifact — the walk excludes it either way; only
 * the record differs.
 *
 * A files:-declared DEST is exempt from the leak rule EVEN WHEN it already
 * exists on disk and is gitignored — that is the expected post-build state
 * of a materialized build artifact (gitignored `dist/` output), not a leak.
 * This is deliberately unconditional on existence (unlike {@link checkDeferred}):
 * the broken case this fixes IS the existing-artifact case. The covered path
 * is recorded as a deferred asset (surfaces as info `LINK_DEFERRED_ARTIFACT`)
 * instead of a `gitignored` exclusion, and stays out of link-traversal
 * bundling — `files:` owns the copy.
 *
 * DEST-ONLY ({@link DeferredArtifacts.coversDest}, not {@link
 * DeferredArtifacts.covers}): a `files:` SOURCE is a real, author-pointed-at
 * file in the project tree, not a build output — if it's gitignored, linking
 * to it is exactly the leak signal this rule exists to catch, so source
 * coverage must NOT exempt it. An uncovered path, or a path covered only via
 * `sourcePaths`, still reports the leak normally.
 */
function classifyGitignoredTarget(
  targetPath: string,
  deferredArtifacts: DeferredArtifacts | undefined,
): ExclusionVerdict {
  return deferredArtifacts?.coversDest(targetPath)
    ? { kind: 'deferred' }
    : { kind: 'excluded', reason: 'gitignored' };
}

/**
 * The `files:`-dest exemption for a target already known to be gitignored.
 *
 * GATED ON EXISTENCE, and the gate is the point. A path that is not there
 * cannot leak anything, and neither ignore oracle can be trusted to say so:
 * {@link GitTracker}'s active set contains only paths that DO exist, so every
 * typo'd link was trivially "absent" and therefore "ignored", and every broken
 * link in a real git repo was reported as `LINK_TO_GITIGNORED_FILE` instead of
 * `LINK_MISSING_TARGET`. `git check-ignore` answers from the ignore PATTERNS
 * and so mislabels a different set — a never-built `dist/out.js` under an
 * ignored `dist/`. Non-existence is classified further down, by
 * {@link processLink}, as `missing-target`.
 *
 * Prefer the pre-populated GitTracker when the caller plumbed one through: it
 * answers in O(1) against the active set, no `git check-ignore` spawn.
 *
 * **Memoized per walk**, so a target named by many documents costs one answer
 * rather than one per reference. The memo cannot change the answer: both
 * oracles are pure functions of the tree, and the memo's lifetime is one walk.
 *
 * ⛔ **Measured on VAT's own tree, 2026-08-09, and the result is a NEGATIVE —
 * do not sell this as a performance win.** Counting asks vs. memo misses in the
 * built lane: `vat audit .` = 3 asks / 2 distinct, `vat skills build` = 0 / 0,
 * `vat inventory .` = 0 / 0. **One** oracle call avoided across all three.
 *
 * The reason is structural, not incidental: this branch is LAST in the cascade,
 * so a target only reaches it after surviving all seven earlier discriminators
 * *and* existing on disk. Nearly every link target is classified before then —
 * bundled markdown, a directory, a navigation file, a pattern match. The memo's
 * real justification is therefore **shape, not speed**: it is what lets the
 * oracle read sit outside {@link classifyExclusion} so that function can be a
 * pure predicate over the row. Any future claim of a spawn-count win needs its
 * own measurement on a corpus where this branch is actually hot.
 *
 * Two further bounds, so nobody reads more into it than it does:
 *
 * - **The collapse is within-ONE-walk fan-in only.** `collectLinkedFiles` calls
 *   {@link walkLinkGraph} once per skill, so a target shared across skills is
 *   still asked about once per skill. That per-walk lifetime is exactly what
 *   makes the memo safe against `packageSkill` writing `dist/` between skills,
 *   so it is a deliberate ceiling, not a missed optimization.
 * - **Not every repeat was a subprocess.** {@link isGitIgnored} settles "is
 *   there a repository here?" from the filesystem and returns early when there
 *   is none, so on a tree with no `.git` ancestor the repeats were ancestor
 *   walks rather than `git check-ignore` spawns. Inside a real repository they
 *   were spawns.
 *
 * @returns whether the target is gitignored
 */
function readGitignored(targetPath: string, options: WalkLinkGraphOptions, state: WalkState): boolean {
  const cached = state.gitignoreFacts.get(targetPath);
  if (cached !== undefined) return cached;

  const isIgnored = options.gitTracker === undefined
    ? isGitIgnored(targetPath, options.projectRoot)
    : options.gitTracker.isIgnoredByActiveSet(targetPath);
  state.gitignoreFacts.set(targetPath, isIgnored);
  return isIgnored;
}

/**
 * The `exists` × `isDirectory` corner of the cascade — the only place the row's
 * three-state `isDirectory` is read.
 *
 * `null` means *no answer about the kind*: the path is present to `existsSync`
 * and unstattable anyway (a permissions problem, or a change racing the two
 * calls). The classifier can say nothing about WHAT the target is — but it can
 * say that the target is there and could not be read, and that is the report.
 *
 * ✅ **This used to skip silently, and that was D6 in the spec's deferred-fixes
 * ledger — now fixed.** `{ kind: 'skipped' }` recorded nothing at all, so an
 * unreadable link target vanished from the report entirely: no exclusion, no
 * bundling, no issue. It survived the pass-1′ refactor only because that
 * refactor was held to byte-identical output (it is what the pre-refactor
 * `catch { return true }` did). Meanwhile the resources lane turned the
 * IDENTICAL class of read failure into a `RESOURCE_UNREADABLE` finding, so one
 * unreadable file got two answers depending on which lane found it. It is now
 * an `unreadable-target` exclusion, which the verdict engine reports as
 * `LINK_TARGET_UNREADABLE` — the resources code's skill-packaging sibling.
 *
 * @returns a verdict when the path's kind decides the outcome, else `undefined`
 */
function classifyPathKind(facts: PathFacts): ExclusionVerdict | undefined {
  if (!facts.exists) return undefined;
  if (facts.isDirectory === true) return { kind: 'excluded', reason: 'directory-target' };
  if (facts.isDirectory === null) return { kind: 'excluded', reason: 'unreadable-target' };
  return undefined;
}

/**
 * The first-match-wins exclusion cascade, as a **pure function of the pass-1′
 * row**. No filesystem access, no walk-state mutation, no recording.
 *
 * ⚠️ **The order IS the behaviour.** This is a cascade, not a set of
 * independent predicates: a directory that is also pattern-matched is reported
 * as `directory-target`, and rewriting it as `reasons.find(...)` over
 * independently-evaluated conditions would silently repick which reason wins.
 * Every branch below sits exactly where it sat when the classifier did its own
 * I/O inline; only the source of the facts changed.
 *
 * The one branch that is not a column is the last one — see
 * {@link readGitignored} for why the gitignore oracle is demand-read at the
 * point the cascade reaches it rather than filled for every row.
 *
 * @returns the verdict, or `undefined` when nothing excludes the target
 */
function classifyExclusion(
  targetPath: string,
  options: WalkLinkGraphOptions,
  excludeMatchers: ExcludeMatcher[],
  facts: PathFacts,
): ExclusionVerdict | undefined {
  // The deferred check is the FIRST discriminator: a not-yet-materialized target
  // must be classified before any check that would read it off disk.
  if (options.deferredArtifacts && checkDeferred(targetPath, facts.exists, options.deferredArtifacts)) {
    return { kind: 'deferred' };
  }

  // Check if target is a directory
  const kindVerdict = classifyPathKind(facts);
  if (kindVerdict) return kindVerdict;

  // Check project boundary
  if (!facts.insideProject) return { kind: 'excluded', reason: 'outside-project' };

  // Check navigation file exclusion
  if (options.excludeNavigationFiles && isNavigationBasename(basename(targetPath))) {
    return { kind: 'excluded', reason: 'navigation-file' };
  }

  // Repo-internal agent-instruction files — see {@link refusesAgentInstructionFile}
  // for why they cannot travel, and for the explicit-`files:` escape hatch.
  if (refusesAgentInstructionFile(targetPath, options)) {
    return { kind: 'excluded', reason: 'agent-instruction-file' };
  }

  // Check for cross-skill SKILL.md links — a SKILL.md is a skill definition marker,
  // not a resource. Bundling another skill's SKILL.md creates duplicate skill definitions
  // in the output, which causes marketplace sync failures and confuses skill consumers.
  //
  // Self-links (a bundled doc linking back to the current skill's own SKILL.md) are
  // silently ignored: no exclusion is recorded. The walker's `visited` set already
  // prevents re-traversal, and the duplicate-definition risk does not apply to the
  // current skill itself.
  if (basename(targetPath) === 'SKILL.md') {
    return safePath.resolve(targetPath) === safePath.resolve(options.skillRootPath)
      ? { kind: 'skipped' }
      : { kind: 'excluded', reason: 'skill-definition' };
  }

  // Check exclude patterns (relative to projectRoot)
  const relativePath = toForwardSlash(safePath.relative(options.projectRoot, targetPath));
  const matchedExclude = excludeMatchers.find((m) => m.isMatch(relativePath));
  if (matchedExclude) {
    return { kind: 'excluded', reason: 'pattern-matched', matchedRule: matchedExclude.rule };
  }

  // Falls through to the cascade's final branch, which is the one that needs an
  // oracle rather than a column — see {@link classifyGitignored}.
  return undefined;
}

/**
 * The cascade's LAST branch, kept out of {@link classifyExclusion} so that
 * function can stay a pure function of the row.
 *
 * Its position at the end is not an implementation detail — it is why the
 * demand-read is safe. Every earlier discriminator has already declined, so the
 * set of paths this asks the oracle about is exactly the set the shipped
 * classifier asked about, link for link.
 *
 * Existence-gated, and the gate is the point: a path that is not there cannot
 * leak anything, and neither oracle can be trusted to say so — see
 * {@link readGitignored}.
 */
function classifyGitignored(
  targetPath: string,
  options: WalkLinkGraphOptions,
  facts: PathFacts,
  state: WalkState,
): ExclusionVerdict | undefined {
  if (!facts.exists) return undefined;
  if (!readGitignored(targetPath, options, state)) return undefined;
  return classifyGitignoredTarget(targetPath, options.deferredArtifacts);
}

/**
 * Apply a verdict to the walk state — the only place the classifier's decision
 * becomes a mutation.
 *
 * @returns true if the caller should stop processing this link
 */
function applyExclusionVerdict(
  verdict: ExclusionVerdict,
  targetPath: string,
  sourcePath: string,
  link: ResourceLink,
  facts: PathFacts,
  state: WalkState,
): boolean {
  switch (verdict.kind) {
    case 'deferred': {
      state.deferredAssetSet.add(toForwardSlash(targetPath));
      return true;
    }
    case 'excluded': {
      state.excludedReferences.push(
        makeExclusion(targetPath, sourcePath, facts.exists, verdict.reason, link, verdict.matchedRule),
      );
      return true;
    }
    case 'skipped': {
      return true;
    }
  }
}

/**
 * Check if a target path should be excluded for structural reasons
 * (deferred build artifact, directory, outside project, navigation file, or
 * pattern match).
 *
 * Pass 1′ fills the row, pass 4 judges it, and the recording is a third step —
 * the three used to be one interleaved function that stat'ed paths mid-cascade.
 *
 * @returns true if the link was excluded or deferred (caller should skip to next link)
 */
function checkExclusions(
  targetPath: string,
  sourcePath: string,
  link: ResourceLink,
  options: WalkLinkGraphOptions,
  excludeMatchers: ExcludeMatcher[],
  state: WalkState,
): boolean {
  const facts = fillPathFacts(targetPath, options, state);
  const verdict = classifyExclusion(targetPath, options, excludeMatchers, facts)
    ?? classifyGitignored(targetPath, options, facts, state);
  if (verdict === undefined) return false;
  return applyExclusionVerdict(verdict, targetPath, sourcePath, link, facts, state);
}

/**
 * Process a single local_file link during the graph walk.
 *
 * Checks exclusions, resolves the target in the registry, and either
 * bundles it (if markdown), records it as an asset, or excludes it.
 */
function processLink(
  link: ResourceLink,
  currentResource: ResourceMetadata,
  currentDepth: number,
  registry: WalkableRegistry,
  options: WalkLinkGraphOptions,
  excludeMatchers: ExcludeMatcher[],
  state: WalkState,
): void {
  const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;

  // Skip empty hrefs (pure anchor links that slipped through type classification)
  // BEFORE resolving: a bare `#anchor` names no file, so there is nothing to resolve.
  if (hrefWithoutAnchor === '') {
    return;
  }

  // Resolve the target path from the link href
  const targetPath = resolveHrefToPath(hrefWithoutAnchor, currentResource.filePath, options.projectRoot);

  // Check structural exclusions (deferred, directory, boundary, navigation, pattern, gitignore)
  if (checkExclusions(targetPath, currentResource.filePath, link, options, excludeMatchers, state)) {
    return;
  }

  // Try to find the target in the registry (markdown files)
  const targetResource = link.resolvedId
    ? registry.getResourceById(link.resolvedId)
    : registry.getResource(targetPath);

  if (targetResource) {
    processRegistryResource(targetResource, targetPath, currentResource.filePath, link, currentDepth, options, state);
    // Straight to the probe, not through `fillPathFacts`: this site wants one
    // column, and building a whole row to read it would compute an
    // `insideProject` the caller immediately discards. The probe memo is what
    // makes it free — this used to be a second `existsSync` of the identical
    // path in the same tick.
  } else if (state.pathProbe.probe(targetPath).exists) {
    // Not in registry — non-markdown asset that exists on disk
    state.bundledAssetSet.add(toForwardSlash(targetPath));
  } else {
    // File doesn't exist and not in registry, and not deferred (handled above).
    // Record as missing-target so downstream emits LINK_MISSING_TARGET.
    state.excludedReferences.push(makeExclusion(targetPath, currentResource.filePath, false, 'missing-target', link));
  }
}

/**
 * Is this file one the walker walks THROUGH, enqueuing its link targets as
 * further bundle members?
 *
 * Routing is markdown-only. HTML may be a registry member — parsed, links
 * known, reachable by the rewriter — without being a door: the decision is
 * "a leaf we can read, not a door we walk through", and it is spec-backed
 * (Anthropic's skill guidance is markdown throughout, and VAT's own stance docs
 * mention HTML nowhere).
 *
 * Keyed on {@link parserKindForPath} rather than a local extension test, so
 * VAT keeps ONE parser discriminator: a format that gains a parser gains a
 * routability answer in the same edit.
 */
function isRoutable(filePath: string): boolean {
  return parserKindForPath(filePath) === 'markdown';
}

/**
 * Record every local-file link out of a bundled non-routable member as a
 * candidate `non-routable-source` exclusion.
 *
 * Without this the targets simply vanish: `SKILL.md → guide.html →
 * diagram.svg` bundles the HTML, never looks inside it, and ships a bundled
 * page whose `<img src>` points at a file that is not there. A silent drop
 * becomes a reported one.
 */
function recordUnfollowedLinks(
  member: ResourceMetadata,
  options: WalkLinkGraphOptions,
  state: WalkState,
): void {
  for (const link of member.links) {
    if (!isLocalFileLink(link.type)) continue;
    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') continue;
    const targetPath = resolveHrefToPath(hrefWithoutAnchor, member.filePath, options.projectRoot);
    const targetExists = state.pathProbe.probe(targetPath).exists;
    state.unfollowedFromNonRoutable.push(
      makeExclusion(targetPath, member.filePath, targetExists, 'non-routable-source', link),
    );
  }
}

/**
 * Process a registry resource link: check routability, depth, cycle, and either
 * bundle or exclude.
 */
function processRegistryResource(
  targetResource: ResourceMetadata,
  targetPath: string,
  sourcePath: string,
  link: ResourceLink,
  currentDepth: number,
  options: WalkLinkGraphOptions,
  state: WalkState,
): void {
  // A non-routable member is a leaf, and leaves are bundled on the same terms
  // as plain assets — which bypass `maxDepth` entirely. Checking routability
  // BEFORE depth is what makes adding HTML to a registry a pure gain: the file
  // still travels exactly as it did when it was an unparsed asset, it is merely
  // parsed now so the rewriter can reach its links. Applying the depth limit
  // here instead would silently DROP HTML that a markdown-only registry shipped.
  if (!isRoutable(targetResource.filePath)) {
    if (state.visitedResourceIds.has(targetResource.id)) {
      return;
    }
    state.visitedResourceIds.add(targetResource.id);
    state.bundledResourceMap.set(targetResource.id, targetResource);
    // `maxBundledDepth` describes how far the walk ROUTED. A leaf does not
    // extend that, any more than a bundled PNG does.
    recordUnfollowedLinks(targetResource, options, state);
    return;
  }

  // Check depth limit. A registry resource came from a disk crawl, so it
  // exists by construction — `targetExists: true` is a fact here, not a guess.
  if (currentDepth >= options.maxDepth) {
    state.excludedReferences.push(makeExclusion(targetPath, sourcePath, true, 'depth-exceeded', link));
    return;
  }

  // Check if already visited (cycle prevention)
  if (state.visitedResourceIds.has(targetResource.id)) {
    return;
  }

  // Bundle and recurse
  state.visitedResourceIds.add(targetResource.id);
  state.bundledResourceMap.set(targetResource.id, targetResource);
  state.maxBundledDepth = Math.max(state.maxBundledDepth, currentDepth + 1);
  state.queue.push([targetResource, currentDepth + 1]);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Walk the link graph starting from a skill resource, using pre-parsed
 * registry data instead of per-file I/O.
 *
 * Semantics match the original `collectLinks()`:
 * - Non-markdown assets bypass depth limits (always bundled unless pattern-excluded)
 * - Markdown links are subject to depth limits and exclude rules
 * - Circular references are handled via a visited set
 * - Glob matching uses forward-slash paths relative to projectRoot
 *
 * @param skillResourceId - The resource ID of the skill's SKILL.md in the registry
 * @param registry - A walkable registry with pre-parsed resources
 * @param options - Walk options (depth, excludes, etc.)
 * @returns Graph walk result with bundled resources, assets, and exclusions
 */
export function walkLinkGraph(
  skillResourceId: string,
  registry: WalkableRegistry,
  options: WalkLinkGraphOptions,
): LinkGraphResult {
  const skillResource = registry.getResourceById(skillResourceId);
  if (!skillResource) {
    return { bundledResources: [], bundledAssets: [], excludedReferences: [], maxBundledDepth: 0, deferredAssets: [] };
  }

  // Compile exclude patterns once
  const excludeMatchers: ExcludeMatcher[] = options.excludeRules.map((rule) => ({
    rule,
    // dot:true — adopter link paths may traverse dotfile segments (.claude/,
    // .worktrees/, .config/). Without it, exclude rules silently never match
    // such paths and the references aren't dropped from the bundle. See
    // [[allow-filter dotfile fix]] for the sibling case.
    isMatch: picomatch(rule.patterns, { dot: true }),
  }));

  // Initialize walk state
  const state: WalkState = {
    visitedResourceIds: new Set<string>([skillResourceId]),
    bundledResourceMap: new Map<string, ResourceMetadata>(),
    bundledAssetSet: new Set<string>(),
    deferredAssetSet: new Set<string>(),
    excludedReferences: [],
    maxBundledDepth: 0,
    queue: [[skillResource, 0]],
    unfollowedFromNonRoutable: [],
    pathProbe: options.pathProbe ?? new FsLookupCache(),
    gitignoreFacts: new Map<string, boolean>(),
  };

  while (state.queue.length > 0) {
    const entry = state.queue.shift();
    if (!entry) {
      break;
    }
    const [currentResource, currentDepth] = entry;

    for (const link of currentResource.links) {
      if (isLocalFileLink(link.type)) {
        processLink(link, currentResource, currentDepth, registry, options, excludeMatchers, state);
      }
    }
  }

  // Promote only the unfollowed links whose targets the walk never bundled by
  // any other route. Deferred artifacts count as accounted-for: the target will
  // exist once the build materializes it, which is the same reason they are not
  // `missing-target`.
  const bundledPaths = new Set<string>([
    ...state.bundledAssetSet,
    ...state.deferredAssetSet,
    ...[...state.bundledResourceMap.values()].map(r => toForwardSlash(r.filePath)),
  ]);
  for (const unfollowed of state.unfollowedFromNonRoutable) {
    if (!bundledPaths.has(toForwardSlash(unfollowed.path))) {
      state.excludedReferences.push(unfollowed);
    }
  }

  return {
    bundledResources: [...state.bundledResourceMap.values()],
    bundledAssets: [...state.bundledAssetSet],
    excludedReferences: state.excludedReferences,
    maxBundledDepth: state.maxBundledDepth,
    deferredAssets: [...state.deferredAssetSet],
  };
}
