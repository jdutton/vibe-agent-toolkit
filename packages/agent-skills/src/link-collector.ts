/**
 * Unified link collection module
 *
 * Provides a single algorithm for collecting and classifying links from a
 * skill's markdown file tree. Used by both the packaging validator (to report
 * excluded references) and the skill packager (to rewrite dead links).
 *
 * Key design decisions:
 * - Non-markdown assets (images, JSON, etc.) are always bundled (no recursion, no depth contribution)
 *   unless they match an exclude pattern
 * - Markdown links are subject to depth limits and exclude rules
 * - excludedReferences is NOT deduped: each occurrence preserves per-link context
 * - bundledFiles IS deduped: same file from multiple paths = one bundle entry
 * - Glob matching uses forward-slash paths relative to skillRoot
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { NAVIGATION_FILE_PATTERNS } from './validators/validation-rules.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Resolution result for a single link found in a bundled markdown file.
 */
export interface LinkResolution {
  /** Absolute path to the linked file */
  path: string;
  /** Whether the file will be bundled */
  bundled: boolean;
  /** Reason it was excluded (only set when bundled is false) */
  excludeReason?: 'depth-exceeded' | 'pattern-matched' | 'directory-target' | 'outside-project' | 'navigation-file' | undefined;
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

/**
 * Default template for depth-exceeded and unmatched excluded links.
 */
export interface DefaultRule {
  template?: string | undefined;
}

/**
 * Options for link collection.
 */
export interface LinkCollectionOptions {
  /** Max depth (Infinity for 'full') */
  maxDepth: number;
  /** Ordered exclude rules (first match wins) */
  excludeRules: ExcludeRule[];
  /** Default handling for depth-exceeded and unmatched excluded links */
  defaultRule: DefaultRule;
  /** Skill root directory for resolving relative paths in glob matching */
  skillRoot: string;
  /** Project root for boundary enforcement */
  projectRoot?: string | undefined;
  /** Whether to exclude navigation files (README.md, index.md, etc.) */
  excludeNavigationFiles?: boolean | undefined;
}

/**
 * Result of collecting links from a skill's markdown file tree.
 */
export interface LinkCollectionResult {
  /** Files within depth AND not excluded -- will be bundled */
  bundledFiles: string[];
  /** Files detected but NOT bundled (depth or exclude) */
  excludedReferences: LinkResolution[];
  /** Actual max depth of the bundled portion */
  maxBundledDepth: number;
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * A resolved link from a markdown file with its metadata.
 */
interface ResolvedLink {
  /** Absolute path to the target file */
  path: string;
  /** Whether the target is a markdown file */
  isMarkdown: boolean;
  /** Whether the target is a directory (not a file) */
  isDirectory?: boolean | undefined;
  /** Whether the target is outside the project boundary */
  isOutsideBoundary?: boolean | undefined;
  /** Link text from the source markdown */
  linkText: string;
  /** Original href from the markdown */
  linkHref: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Create an exclusion record from a resolved link */
function makeExclusion(
  link: ResolvedLink,
  reason: LinkResolution['excludeReason'],
  matchedRule?: ExcludeRule,
): LinkResolution {
  return {
    path: link.path,
    bundled: false,
    excludeReason: reason,
    ...(matchedRule ? { matchedRule } : {}),
    linkText: link.linkText,
    linkHref: link.linkHref,
  };
}

/** Check if a link should be excluded before pattern matching */
function getPrePatternExcludeReason(
  link: ResolvedLink,
  options: LinkCollectionOptions,
): LinkResolution['excludeReason'] | null {
  if (link.isDirectory) {
    return 'directory-target';
  }
  if (link.isOutsideBoundary) {
    return 'outside-project';
  }
  if (options.excludeNavigationFiles) {
    const filename = basename(link.path);
    if ((NAVIGATION_FILE_PATTERNS as readonly string[]).includes(filename)) {
      return 'navigation-file';
    }
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Collect all links from a skill's markdown file tree, classifying each as
 * bundled or excluded.
 *
 * This is the core algorithm used by both the packaging validator and the
 * skill packager. It walks the markdown link tree starting from the given
 * skill file, respecting depth limits and exclude rules.
 *
 * @param markdownPath - Absolute path to the root SKILL.md file
 * @param options - Collection options (depth, excludes, etc.)
 * @returns Collection result with bundled files and excluded references
 */
export async function collectLinks(
  markdownPath: string,
  options: LinkCollectionOptions,
): Promise<LinkCollectionResult> {
  const visited = new Set<string>();

  return collectLinksRecursive(markdownPath, visited, options, 0);
}

// ============================================================================
// Internal Implementation
// ============================================================================

/**
 * Recursive link collection with depth tracking and cycle prevention.
 *
 * Depth semantics:
 * - currentDepth starts at 0 for links found in the root SKILL.md
 * - The depth check `currentDepth >= maxDepth` is applied to markdown links
 *   BEFORE recursing into them
 * - Non-markdown assets bypass the depth check entirely
 *
 * @param markdownPath - Current markdown file being processed
 * @param visited - Set of already-visited normalized paths (cycle prevention)
 * @param options - Collection options
 * @param currentDepth - Current depth in the link tree (0 = root's direct links)
 * @returns Accumulated collection result
 */
async function collectLinksRecursive(
  markdownPath: string,
  visited: Set<string>,
  options: LinkCollectionOptions,
  currentDepth: number,
): Promise<LinkCollectionResult> {
  const normalizedPath = resolve(markdownPath);

  // Prevent infinite loops from circular references
  if (visited.has(normalizedPath)) {
    return { bundledFiles: [], excludedReferences: [], maxBundledDepth: 0 };
  }
  visited.add(normalizedPath);

  // Parse the markdown file to extract links
  const parseResult = await parseMarkdown(markdownPath);

  // Resolve all local file links (both markdown and non-markdown)
  const resolvedLinks = resolveLocalLinks(parseResult.links, markdownPath, options.projectRoot);

  const bundledFilesSet = new Set<string>();
  const excludedReferences: LinkResolution[] = [];
  let maxBundledDepth = 0;

  // Compile exclude patterns once for this invocation
  const excludeMatchers = options.excludeRules.map((rule) => ({
    rule,
    isMatch: picomatch(rule.patterns),
  }));

  for (const link of resolvedLinks) {
    // Step 0: Check pre-pattern exclusions (directory, outside-project, navigation)
    const prePatternReason = getPrePatternExcludeReason(link, options);
    if (prePatternReason !== null) {
      excludedReferences.push(makeExclusion(link, prePatternReason));
      continue;
    }

    // Step 1: Check exclude rules (applies to ALL file types)
    // Use projectRoot (when available) as the base for glob matching.
    // skillRoot is dirname(SKILL.md) which may be deep inside the package;
    // files outside it produce ../  prefixes that picomatch ** cannot match.
    const matchBase = options.projectRoot ?? options.skillRoot;
    const relativePath = toForwardSlash(relative(matchBase, link.path));
    const matchedExclude = excludeMatchers.find((m) => m.isMatch(relativePath));

    if (matchedExclude) {
      excludedReferences.push(makeExclusion(link, 'pattern-matched', matchedExclude.rule));
      continue;
    }

    // Step 2: Non-markdown assets are always bundled (no recursion, no depth contribution)
    if (!link.isMarkdown) {
      bundledFilesSet.add(link.path);
      continue;
    }

    // Step 3: Markdown link -- check depth limit
    if (currentDepth >= options.maxDepth) {
      excludedReferences.push(makeExclusion(link, 'depth-exceeded'));
      continue;
    }

    // Within depth -- bundle and recurse
    bundledFilesSet.add(link.path);

    const childResult = await collectLinksRecursive(
      link.path,
      visited,
      options,
      currentDepth + 1,
    );

    // Merge child results
    for (const childFile of childResult.bundledFiles) {
      bundledFilesSet.add(childFile);
    }
    excludedReferences.push(...childResult.excludedReferences);

    // Track the deepest bundled depth
    // The child was at currentDepth+1, so its maxBundledDepth is relative to the root
    const childDepth = childResult.maxBundledDepth > 0
      ? childResult.maxBundledDepth
      : currentDepth + 1;
    maxBundledDepth = Math.max(maxBundledDepth, childDepth);
  }

  return {
    bundledFiles: [...bundledFilesSet],
    excludedReferences,
    maxBundledDepth,
  };
}

/**
 * Resolve all local file links from parsed markdown, returning both markdown
 * and non-markdown targets.
 *
 * Filters to `local_file` type links, strips anchors, resolves relative paths,
 * and checks file existence. Marks links outside project boundary instead of
 * silently dropping them.
 *
 * @param links - Raw links from parseMarkdown result
 * @param markdownPath - Path of the source markdown file (for relative resolution)
 * @param projectRoot - Optional boundary for path enforcement
 * @returns Array of resolved links with metadata
 */
function resolveLocalLinks(
  links: Array<{ href: string; type: string; text?: string | undefined; line?: number | undefined }>,
  markdownPath: string,
  projectRoot?: string | undefined,
): ResolvedLink[] {
  const resolved: ResolvedLink[] = [];

  for (const link of links) {
    if (link.type !== 'local_file') {
      continue;
    }

    // Strip anchor from href
    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') {
      continue;
    }

    // Resolve to absolute path
    const resolvedPath = resolve(dirname(markdownPath), hrefWithoutAnchor);

    // Check file existence
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from parsed markdown links
    if (!existsSync(resolvedPath)) {
      continue;
    }

    // Check project boundary (mark, don't drop)
    const outsideBoundary = projectRoot !== undefined
      && relative(projectRoot, resolvedPath).startsWith('..');

    // Check if target is a directory (not a file)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from parsed markdown links
    const stats = statSync(resolvedPath);
    if (stats.isDirectory()) {
      resolved.push({
        path: resolvedPath,
        isMarkdown: false,
        isDirectory: true,
        linkText: link.text ?? '',
        linkHref: link.href,
      });
      continue;
    }

    const isMarkdown = resolvedPath.endsWith('.md');

    resolved.push({
      path: resolvedPath,
      isMarkdown,
      ...(outsideBoundary ? { isOutsideBoundary: true } : {}),
      linkText: link.text ?? '',
      linkHref: link.href,
    });
  }

  return resolved;
}
