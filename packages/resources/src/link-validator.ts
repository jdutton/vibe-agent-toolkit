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

import { isGitIgnored, type GitTracker } from '@vibe-agent-toolkit/utils';

import type { ValidationIssue } from './schemas/validation-result.js';
import type { HeadingNode, ResourceLink } from './types.js';
import { isWithinProject, splitHrefAnchor } from './utils.js';

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
 * Validate a local file link (with optional anchor).
 */
async function validateLocalFileLink(
  link: ResourceLink,
  sourceFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>,
  options?: ValidateLinkOptions
): Promise<ValidationIssue | null> {
  // Extract file path and anchor from href
  const [filePath, anchor] = splitHrefAnchor(link.href);

  // Validate the file exists
  const fileResult = await validateLocalFile(filePath, sourceFilePath);

  if (!fileResult.exists) {
    return {
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message: `File not found: ${fileResult.resolvedPath}`,
      suggestion: '',
    };
  }

  // Check git-ignore safety (Phase 3)
  // Only check if:
  // 1. skipGitIgnoreCheck is NOT true
  // 2. projectRoot is provided
  // 3. target is within project (skip for external resources)
  if (
    options?.skipGitIgnoreCheck !== true &&
    options?.projectRoot !== undefined &&
    isWithinProject(fileResult.resolvedPath, options.projectRoot)
  ) {
    // Use GitTracker if available (cached), otherwise fall back to isGitIgnored
    const sourceIsIgnored = options.gitTracker
      ? options.gitTracker.isIgnored(sourceFilePath)
      : isGitIgnored(sourceFilePath, options.projectRoot);
    const targetIsIgnored = options.gitTracker
      ? options.gitTracker.isIgnored(fileResult.resolvedPath)
      : isGitIgnored(fileResult.resolvedPath, options.projectRoot);

    // Error ONLY if: source is NOT ignored AND target IS ignored
    if (!sourceIsIgnored && targetIsIgnored) {
      return {
        resourcePath: sourceFilePath,
        line: link.line,
        type: 'link_to_gitignored',
        link: link.href,
        message: `Non-ignored file links to gitignored file: ${fileResult.resolvedPath}. Gitignored files are local-only and will not exist in the repository. Remove this link or unignore the target file.`,
        suggestion: '',
      };
    }
  }

  // If there's an anchor, validate it too
  if (anchor) {
    const anchorValid = await validateAnchor(
      anchor,
      fileResult.resolvedPath,
      headingsByFile
    );

    if (!anchorValid) {
      return {
        resourcePath: sourceFilePath,
        line: link.line,
        type: 'broken_anchor',
        link: link.href,
        message: `Anchor not found: #${anchor} in ${fileResult.resolvedPath}`,
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
 * Validate that a local file exists.
 *
 * @param href - The href to the file (relative or absolute)
 * @param sourceFilePath - Absolute path to the source file
 * @returns Object with exists flag and resolved absolute path
 *
 * @example
 * ```typescript
 * const result = await validateLocalFile('./docs/guide.md', '/project/README.md');
 * if (result.exists) {
 *   console.log('File exists at:', result.resolvedPath);
 * }
 * ```
 */
async function validateLocalFile(
  href: string,
  sourceFilePath: string
): Promise<{ exists: boolean; resolvedPath: string }> {
  // Resolve the path relative to the source file's directory
  const sourceDir = path.dirname(sourceFilePath);
  const resolvedPath = path.resolve(sourceDir, href);

  // Check if file exists
  let exists = false;
  try {
    await fs.access(resolvedPath, fs.constants.F_OK);
    exists = true;
  } catch {
    exists = false;
  }

  return { exists, resolvedPath };
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
