/**
 * Link validation for markdown resources.
 *
 * Validates different types of links:
 * - local_file: Checks if file exists, validates anchors if present, checks git-ignore safety
 * - anchor: Validates heading exists in current or target file
 * - external: Returns info (not validated)
 * - email: Returns null (valid by default)
 * - unknown: Returns warning
 *
 * Git-ignore safety (Phase 3):
 * - Non-ignored files cannot link to ignored files (error: link_to_gitignored)
 * - Ignored files CAN link to ignored files (no error)
 * - Ignored files CAN link to non-ignored files (no error)
 * - External resources (outside project) skip git-ignore checks
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  isGitIgnored,
  type GitTracker,
  verifyCaseSensitiveFilename,
} from '@vibe-agent-toolkit/utils';

import type { ValidationIssue } from './schemas/validation-result.js';
import type { HeadingNode, ResourceLink } from './types.js';
import { isWithinProject, resolveLocalHref } from './utils.js';

/**
 * Options for link validation.
 */
export interface ValidateLinkOptions {
  /** Project root directory (for git-ignore checking) */
  projectRoot?: string;
  /** Skip git-ignore checks (optimization when checkGitIgnored is false) */
  skipGitIgnoreCheck?: boolean;
  /** Git tracker for efficient git-ignore checking (optional, improves performance) */
  gitTracker?: GitTracker;
}

/**
 * Validate a single link in a markdown resource.
 *
 * @param link - The link to validate
 * @param sourceFilePath - Absolute path to the file containing the link
 * @param headingsByFile - Map of file paths to their heading trees
 * @param options - Validation options (projectRoot, skipGitIgnoreCheck)
 * @returns ValidationIssue if link is broken, null if valid
 *
 * @example
 * ```typescript
 * const issue = await validateLink(link, '/project/docs/guide.md', headingsMap, {
 *   projectRoot: '/project',
 *   skipGitIgnoreCheck: false
 * });
 * if (issue) {
 *   console.log(`${issue.severity}: ${issue.message}`);
 * }
 * ```
 */
export async function validateLink(
  link: ResourceLink,
  sourceFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>,
  options?: ValidateLinkOptions
): Promise<ValidationIssue | null> {
  switch (link.type) {
    case 'local_file':
      return await validateLocalFileLink(link, sourceFilePath, headingsByFile, options);

    case 'anchor':
      return await validateAnchorLink(link, sourceFilePath, headingsByFile);

    case 'external':
      // External URLs are not validated - don't report them
      return null;

    case 'email':
      // Email links are valid by default
      return null;

    case 'unknown':
      return {
        resourcePath: sourceFilePath,
        line: link.line,
        type: 'unknown_link',
        link: link.href,
        message: 'Unknown link type',
      };

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = link.type;
      return _exhaustive;
    }
  }
}

/**
 * Convert a resolution failure kind to a broken_file ValidationIssue. Returns
 * null for `resolved` (caller continues) and `anchor_only` (defensive no-op —
 * the parser classifies anchor-only hrefs as 'anchor', not 'local_file').
 */
function resolutionFailureIssue(
  resolved: ReturnType<typeof resolveLocalHref>,
  link: ResourceLink,
  sourceFilePath: string,
): ValidationIssue | null {
  if (resolved.kind === 'absolute_no_root') {
    return {
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message:
        `Absolute-path link "${link.href}" requires a configured projectRoot; ` +
        `none was provided. Configure vibe-agent-toolkit.config.yaml or run ` +
        `from within a git repository.`,
      suggestion:
        'Rewrite as a source-relative link, or run from a directory with a config or git ancestor.',
    };
  }

  if (resolved.kind === 'absolute_escapes_root') {
    return {
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message: `Absolute-path link "${link.href}" escapes the project root via path traversal.`,
      suggestion: '',
    };
  }

  return null;
}

/**
 * Convert a non-existent file result into a broken_file ValidationIssue.
 * Returns null when the file exists.
 */
function fileExistenceIssue(
  fileResult: { exists: boolean; resolvedPath: string; actualName?: string },
  link: ResourceLink,
  sourceFilePath: string,
): ValidationIssue | null {
  if (fileResult.exists) return null;

  if (fileResult.actualName) {
    const expectedName = path.basename(fileResult.resolvedPath);
    return {
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message: `File found but case mismatch: expected "${expectedName}" but found "${fileResult.actualName}". This will fail on case-sensitive filesystems (Linux). Update the link to match the actual filename.`,
      suggestion: `Use "${fileResult.actualName}" instead of "${expectedName}"`,
    };
  }

  return {
    resourcePath: sourceFilePath,
    line: link.line,
    type: 'broken_file',
    link: link.href,
    message: `File not found: ${fileResult.resolvedPath}`,
    suggestion: '',
  };
}

/**
 * Check git-ignore safety: a non-ignored source file must not link to a
 * gitignored target. Returns a ValidationIssue when this rule is violated,
 * null otherwise (including when checks are disabled or out of scope).
 */
function gitIgnoreSafetyIssue(
  link: ResourceLink,
  sourceFilePath: string,
  resolvedTarget: string,
  options: ValidateLinkOptions | undefined,
): ValidationIssue | null {
  if (
    options?.skipGitIgnoreCheck === true ||
    options?.projectRoot === undefined ||
    !isWithinProject(resolvedTarget, options.projectRoot)
  ) {
    return null;
  }

  // Prefer the O(1) active-set lookup on the shared GitTracker (no spawn).
  // isIgnoredByActiveSet falls back internally to isIgnored for paths outside
  // the project root, so this is safe for the rare out-of-project case.
  // When no tracker is threaded in, fall back to isGitIgnored (one-off spawn).
  const sourceIsIgnored = options.gitTracker
    ? options.gitTracker.isIgnoredByActiveSet(sourceFilePath)
    : isGitIgnored(sourceFilePath, options.projectRoot);
  const targetIsIgnored = options.gitTracker
    ? options.gitTracker.isIgnoredByActiveSet(resolvedTarget)
    : isGitIgnored(resolvedTarget, options.projectRoot);

  if (sourceIsIgnored || !targetIsIgnored) return null;

  return {
    resourcePath: sourceFilePath,
    line: link.line,
    type: 'link_to_gitignored',
    link: link.href,
    message: `Non-ignored file links to gitignored file: ${resolvedTarget}. Gitignored files are local-only and will not exist in the repository. Remove this link or unignore the target file.`,
    suggestion: '',
  };
}

/**
 * Validate a local file link (with optional anchor).
 */
async function validateLocalFileLink(
  link: ResourceLink,
  sourceFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>,
  options?: ValidateLinkOptions
): Promise<ValidationIssue | null> {
  const resolved = resolveLocalHref(link.href, sourceFilePath, options?.projectRoot);

  if (resolved.kind !== 'resolved') {
    // anchor_only → null no-op; absolute_no_root / absolute_escapes_root → broken_file.
    return resolutionFailureIssue(resolved, link, sourceFilePath);
  }

  const fileResult = await validateResolvedFile(resolved.resolvedPath);
  const notFound = fileExistenceIssue(fileResult, link, sourceFilePath);
  if (notFound) return notFound;

  if (fileResult.isDirectory) {
    return {
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message: `Link target is a directory: ${fileResult.resolvedPath}`,
      suggestion:
        'Link to a file inside the directory (e.g., README.md or index.md), or fix the link to point at the intended file.',
    };
  }

  const gitIgnoreIssue = gitIgnoreSafetyIssue(link, sourceFilePath, fileResult.resolvedPath, options);
  if (gitIgnoreIssue) return gitIgnoreIssue;

  if (resolved.anchor) {
    const anchorValid = await validateAnchor(resolved.anchor, fileResult.resolvedPath, headingsByFile);
    if (!anchorValid) {
      return {
        resourcePath: sourceFilePath,
        line: link.line,
        type: 'broken_anchor',
        link: link.href,
        message: `Anchor not found: #${resolved.anchor} in ${fileResult.resolvedPath}`,
        suggestion: '',
      };
    }
  }

  return null;
}

/**
 * Validate an anchor link (within current file).
 */
async function validateAnchorLink(
  link: ResourceLink,
  sourceFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>
): Promise<ValidationIssue | null> {
  // Extract anchor (strip leading #)
  const anchor = link.href.startsWith('#') ? link.href.slice(1) : link.href;

  // Validate anchor exists in current file
  const isValid = await validateAnchor(anchor, sourceFilePath, headingsByFile);

  if (!isValid) {
    return {
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_anchor',
      link: link.href,
      message: `Anchor not found: ${link.href}`,
      suggestion: '',
    };
  }

  return null;
}


/**
 * Verify that the resolved filesystem path exists with the correct case.
 *
 * @param resolvedPath - Absolute filesystem path produced by {@link resolveLocalHref}.
 * @returns Object with exists flag, the path, and optional case-mismatch info.
 */
async function validateResolvedFile(
  resolvedPath: string,
): Promise<{ exists: boolean; resolvedPath: string; actualName?: string; isDirectory: boolean }> {
  const verification = await verifyCaseSensitiveFilename(resolvedPath);

  let isDirectory = false;
  if (verification.exists) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedPath validated by verifyCaseSensitiveFilename
      const stats = await fs.stat(resolvedPath);
      isDirectory = stats.isDirectory();
    } catch {
      // Stat failed after verifyCaseSensitiveFilename said exists — treat as file.
    }
  }

  const result: { exists: boolean; resolvedPath: string; actualName?: string; isDirectory: boolean } = {
    exists: verification.exists,
    resolvedPath,
    isDirectory,
  };

  if (verification.actualName) {
    result.actualName = verification.actualName;
  }

  return result;
}

/**
 * Validate that an anchor (heading slug) exists in a file.
 *
 * @param anchor - The heading slug to find (without leading #)
 * @param targetFilePath - Absolute path to the file containing the heading
 * @param headingsByFile - Map of file paths to their heading trees
 * @returns True if anchor exists, false otherwise
 *
 * @example
 * ```typescript
 * const valid = await validateAnchor('my-heading', '/project/docs/guide.md', headingsMap);
 * ```
 */
async function validateAnchor(
  anchor: string,
  targetFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>
): Promise<boolean> {
  // Get headings for target file
  const headings = headingsByFile.get(targetFilePath);
  if (!headings) {
    return false;
  }

  // Search for matching slug (case-insensitive)
  return findHeadingBySlug(headings, anchor);
}

/**
 * Recursively search heading tree for a matching slug.
 *
 * Performs case-insensitive comparison of slugs.
 *
 * @param headings - Array of heading nodes to search
 * @param targetSlug - The slug to find
 * @returns True if slug found, false otherwise
 *
 * @example
 * ```typescript
 * const found = findHeadingBySlug(headings, 'my-heading');
 * ```
 */
function findHeadingBySlug(
  headings: HeadingNode[],
  targetSlug: string
): boolean {
  const normalizedTarget = targetSlug.toLowerCase();

  for (const heading of headings) {
    // Check current heading
    if (heading.slug.toLowerCase() === normalizedTarget) {
      return true;
    }

    // Recursively check children
    if (heading.children && findHeadingBySlug(heading.children, targetSlug)) {
      return true;
    }
  }

  return false;
}
