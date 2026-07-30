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
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { isLocalFileLink, resolveLocalHref } from '@vibe-agent-toolkit/resources';
import type { DeferredArtifacts, ResourceLink, ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { type GitTracker, isGitIgnored, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { NAVIGATION_FILE_PATTERNS } from './validators/validation-rules.js';

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
  /** Whether the file will be bundled */
  bundled: boolean;
  /** Reason it was excluded (only set when bundled is false) */
  excludeReason?: 'depth-exceeded' | 'pattern-matched' | 'directory-target' | 'outside-project' | 'navigation-file' | 'skill-definition' | 'gitignored' | 'missing-target' | undefined;
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
   *   discriminator in {@link checkExclusions}) — covered via dest OR source.
   * - The target exists, is gitignored, AND is covered as a DEST (the
   *   gitignore branch in {@link checkExclusions}) — the expected state of a
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

/** Check if a filename is a navigation file */
function isNavigationFile(filename: string): boolean {
  return (NAVIGATION_FILE_PATTERNS as readonly string[]).includes(filename);
}

/** Create an exclusion record */
function makeExclusion(
  targetPath: string,
  sourcePath: string,
  reason: LinkResolution['excludeReason'],
  link: ResourceLink,
  matchedRule?: ExcludeRule,
): LinkResolution {
  return {
    path: targetPath,
    sourcePath,
    ...(link.line !== undefined && { sourceLine: link.line }),
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
}

/** Compiled exclude matcher (pattern + original rule) */
interface ExcludeMatcher {
  rule: ExcludeRule;
  isMatch: (path: string) => boolean;
}

/**
 * Check if a target path is a not-yet-materialized deferred build artifact, and
 * record it in the deferred set if so. Must run BEFORE any statSync / directory
 * check to avoid blowing up on missing paths.
 *
 * This check is gated on the target NOT existing on disk: it classifies the
 * "hasn't been built yet" half of the deferred-artifact lifecycle. An
 * existing real file at a covered files: dest (or source) is NOT deferred by
 * THIS check — it falls through to the directory-target check and beyond.
 * The gitignore branch further down in {@link checkExclusions} carries its
 * OWN, unconditional `deferredArtifacts` exemption (existing or not) for the
 * "already built, and gitignored as expected" half — see the comment there.
 * So an existing-but-gitignored covered path still ends up classified as
 * deferred, just via that branch rather than this one; only an
 * existing-and-NOT-gitignored covered path (or an uncovered path) reaches
 * normal handling. {@link DeferredArtifacts.covers} does the exact-OR-
 * directory-prefix membership test (pure, no filesystem access); the
 * existence gate stays here at the call site.
 *
 * @returns true if the path was classified as deferred
 */
function checkDeferred(
  targetPath: string,
  deferredArtifacts: DeferredArtifacts,
  deferredAssetSet: Set<string>,
): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from parsed markdown
  if (deferredArtifacts.covers(targetPath) && !existsSync(targetPath)) {
    deferredAssetSet.add(toForwardSlash(targetPath));
    return true;
  }
  return false;
}

/**
 * Record a gitignored target as either a leak or an exempted `files:` build
 * artifact — the caller always excludes it from the walk either way; only
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
function recordGitignoredTarget(
  targetPath: string,
  sourcePath: string,
  link: ResourceLink,
  deferredArtifacts: DeferredArtifacts | undefined,
  excludedReferences: LinkResolution[],
  deferredAssetSet: Set<string>,
): void {
  if (deferredArtifacts?.coversDest(targetPath)) {
    deferredAssetSet.add(toForwardSlash(targetPath));
    return;
  }
  excludedReferences.push(makeExclusion(targetPath, sourcePath, 'gitignored', link));
}

/**
 * Check if a target path should be excluded for structural reasons
 * (deferred build artifact, directory, outside project, navigation file, or
 * pattern match).
 *
 * @returns true if the link was excluded or deferred (caller should skip to next link)
 */
function checkExclusions(
  targetPath: string,
  sourcePath: string,
  link: ResourceLink,
  options: WalkLinkGraphOptions,
  excludeMatchers: ExcludeMatcher[],
  excludedReferences: LinkResolution[],
  deferredAssetSet: Set<string>,
): boolean {
  // The deferred check is the FIRST discriminator: a not-yet-materialized target
  // must be classified before any check that would read it off disk.
  if (options.deferredArtifacts && checkDeferred(targetPath, options.deferredArtifacts, deferredAssetSet)) {
    return true;
  }

  // Check if target is a directory
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from parsed markdown
    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      excludedReferences.push(makeExclusion(targetPath, sourcePath, 'directory-target', link));
      return true;
    }
  } catch {
    // statSync failure = skip
    return true;
  }

  // Check project boundary
  if (isOutsideProject(targetPath, options.projectRoot)) {
    excludedReferences.push(makeExclusion(targetPath, sourcePath, 'outside-project', link));
    return true;
  }

  // Check navigation file exclusion
  if (options.excludeNavigationFiles && isNavigationFile(basename(targetPath))) {
    excludedReferences.push(makeExclusion(targetPath, sourcePath, 'navigation-file', link));
    return true;
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
    if (safePath.resolve(targetPath) !== safePath.resolve(options.skillRootPath)) {
      excludedReferences.push(makeExclusion(targetPath, sourcePath, 'skill-definition', link));
    }
    return true;
  }

  // Check exclude patterns (relative to projectRoot)
  const relativePath = toForwardSlash(safePath.relative(options.projectRoot, targetPath));
  const matchedExclude = excludeMatchers.find((m) => m.isMatch(relativePath));
  if (matchedExclude) {
    excludedReferences.push(makeExclusion(targetPath, sourcePath, 'pattern-matched', link, matchedExclude.rule));
    return true;
  }

  // Check if the file is gitignored (prevents leaking data from ignored directories).
  // Prefer the pre-populated GitTracker when the caller plumbed one through: it
  // answers in O(1) against the active set, no `git check-ignore` spawn.
  const isIgnored = options.gitTracker === undefined
    ? isGitIgnored(targetPath, options.projectRoot)
    : options.gitTracker.isIgnoredByActiveSet(targetPath);
  if (isIgnored) {
    recordGitignoredTarget(targetPath, sourcePath, link, options.deferredArtifacts, excludedReferences, deferredAssetSet);
    return true;
  }

  return false;
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
  if (checkExclusions(targetPath, currentResource.filePath, link, options, excludeMatchers, state.excludedReferences, state.deferredAssetSet)) {
    return;
  }

  // Try to find the target in the registry (markdown files)
  const targetResource = link.resolvedId
    ? registry.getResourceById(link.resolvedId)
    : registry.getResource(targetPath);

  if (targetResource) {
    processRegistryResource(targetResource, targetPath, currentResource.filePath, link, currentDepth, options, state);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from parsed markdown
  } else if (existsSync(targetPath)) {
    // Not in registry — non-markdown asset that exists on disk
    state.bundledAssetSet.add(toForwardSlash(targetPath));
  } else {
    // File doesn't exist and not in registry, and not deferred (handled above).
    // Record as missing-target so downstream emits LINK_MISSING_TARGET.
    state.excludedReferences.push(makeExclusion(targetPath, currentResource.filePath, 'missing-target', link));
  }
}

/**
 * Process a registry resource link: check depth, cycle, and either bundle or exclude.
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
  // Check depth limit
  if (currentDepth >= options.maxDepth) {
    state.excludedReferences.push(makeExclusion(targetPath, sourcePath, 'depth-exceeded', link));
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

  return {
    bundledResources: [...state.bundledResourceMap.values()],
    bundledAssets: [...state.bundledAssetSet],
    excludedReferences: state.excludedReferences,
    maxBundledDepth: state.maxBundledDepth,
    deferredAssets: [...state.deferredAssetSet],
  };
}
