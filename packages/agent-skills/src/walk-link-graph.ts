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
import { basename, dirname, relative, resolve } from 'node:path';

import type { ResourceLink, ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import type { ExcludeRule, LinkResolution } from './link-collector.js';
import { NAVIGATION_FILE_PATTERNS } from './validators/validation-rules.js';

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
  /** Whether to exclude navigation files (README.md, index.md, etc.) */
  excludeNavigationFiles?: boolean;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Resolve a link's href to an absolute file path, stripping any anchor */
function resolveHrefToPath(href: string, sourceFilePath: string): string {
  const anchorIndex = href.indexOf('#');
  const hrefWithoutAnchor = anchorIndex === -1 ? href : href.slice(0, anchorIndex);
  return resolve(dirname(sourceFilePath), hrefWithoutAnchor);
}

/** Check if a link targets a file outside the project boundary */
function isOutsideProject(targetPath: string, projectRoot: string): boolean {
  return relative(projectRoot, targetPath).startsWith('..');
}

/** Check if a filename is a navigation file */
function isNavigationFile(filename: string): boolean {
  return (NAVIGATION_FILE_PATTERNS as readonly string[]).includes(filename);
}

/** Create an exclusion record */
function makeExclusion(
  targetPath: string,
  reason: LinkResolution['excludeReason'],
  link: ResourceLink,
  matchedRule?: ExcludeRule,
): LinkResolution {
  return {
    path: targetPath,
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
 * Check if a target path should be excluded for structural reasons
 * (directory, outside project, navigation file, or pattern match).
 *
 * @returns true if the link was excluded (caller should skip to next link)
 */
function checkExclusions(
  targetPath: string,
  link: ResourceLink,
  options: WalkLinkGraphOptions,
  excludeMatchers: ExcludeMatcher[],
  excludedReferences: LinkResolution[],
): boolean {
  // Check if target is a directory
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from parsed markdown
    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      excludedReferences.push(makeExclusion(targetPath, 'directory-target', link));
      return true;
    }
  } catch {
    // statSync failure = skip
    return true;
  }

  // Check project boundary
  if (isOutsideProject(targetPath, options.projectRoot)) {
    excludedReferences.push(makeExclusion(targetPath, 'outside-project', link));
    return true;
  }

  // Check navigation file exclusion
  if (options.excludeNavigationFiles && isNavigationFile(basename(targetPath))) {
    excludedReferences.push(makeExclusion(targetPath, 'navigation-file', link));
    return true;
  }

  // Check exclude patterns (relative to projectRoot)
  const relativePath = toForwardSlash(relative(options.projectRoot, targetPath));
  const matchedExclude = excludeMatchers.find((m) => m.isMatch(relativePath));
  if (matchedExclude) {
    excludedReferences.push(makeExclusion(targetPath, 'pattern-matched', link, matchedExclude.rule));
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
  // Resolve the target path from the link href
  const targetPath = resolveHrefToPath(link.href, currentResource.filePath);
  const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;

  // Skip empty hrefs (pure anchor links that slipped through type classification)
  if (hrefWithoutAnchor === '') {
    return;
  }

  // Check structural exclusions (directory, boundary, navigation, pattern)
  if (checkExclusions(targetPath, link, options, excludeMatchers, state.excludedReferences)) {
    return;
  }

  // Try to find the target in the registry (markdown files)
  const targetResource = link.resolvedId
    ? registry.getResourceById(link.resolvedId)
    : registry.getResource(targetPath);

  if (targetResource) {
    processRegistryResource(targetResource, targetPath, link, currentDepth, options, state);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from parsed markdown
  } else if (existsSync(targetPath)) {
    // Not in registry — non-markdown asset that exists on disk
    state.bundledAssetSet.add(toForwardSlash(targetPath));
  }
  // If file doesn't exist and not in registry, silently skip (same as old collectLinks)
}

/**
 * Process a registry resource link: check depth, cycle, and either bundle or exclude.
 */
function processRegistryResource(
  targetResource: ResourceMetadata,
  targetPath: string,
  link: ResourceLink,
  currentDepth: number,
  options: WalkLinkGraphOptions,
  state: WalkState,
): void {
  // Check depth limit
  if (currentDepth >= options.maxDepth) {
    state.excludedReferences.push(makeExclusion(targetPath, 'depth-exceeded', link));
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
    return { bundledResources: [], bundledAssets: [], excludedReferences: [], maxBundledDepth: 0 };
  }

  // Compile exclude patterns once
  const excludeMatchers: ExcludeMatcher[] = options.excludeRules.map((rule) => ({
    rule,
    isMatch: picomatch(rule.patterns),
  }));

  // Initialize walk state
  const state: WalkState = {
    visitedResourceIds: new Set<string>([skillResourceId]),
    bundledResourceMap: new Map<string, ResourceMetadata>(),
    bundledAssetSet: new Set<string>(),
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
      if (link.type === 'local_file') {
        processLink(link, currentResource, currentDepth, registry, options, excludeMatchers, state);
      }
    }
  }

  return {
    bundledResources: [...state.bundledResourceMap.values()],
    bundledAssets: [...state.bundledAssetSet],
    excludedReferences: state.excludedReferences,
    maxBundledDepth: state.maxBundledDepth,
  };
}
