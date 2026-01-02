/**
 * Link validation for markdown resources.
 *
 * Validates different types of links:
 * - local_file: Checks if file exists, validates anchors if present
 * - anchor: Validates heading exists in current or target file
 * - external: Returns info (not validated)
 * - email: Returns null (valid by default)
 * - unknown: Returns warning
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { isGitignored } from '@vibe-agent-toolkit/utils';

import type { ValidationIssue } from './schemas/validation-result.js';
import type { HeadingNode, ResourceLink } from './types.js';
import { splitHrefAnchor } from './utils.js';

/**
 * Validate a single link in a markdown resource.
 *
 * @param link - The link to validate
 * @param sourceFilePath - Absolute path to the file containing the link
 * @param headingsByFile - Map of file paths to their heading trees
 * @returns ValidationIssue if link is broken, null if valid
 *
 * @example
 * ```typescript
 * const issue = await validateLink(link, '/project/docs/guide.md', headingsMap);
 * if (issue) {
 *   console.log(`${issue.severity}: ${issue.message}`);
 * }
 * ```
 */
export async function validateLink(
  link: ResourceLink,
  sourceFilePath: string,
  headingsByFile: Map<string, HeadingNode[]>
): Promise<ValidationIssue | null> {
  switch (link.type) {
    case 'local_file':
      return await validateLocalFileLink(link, sourceFilePath, headingsByFile);

    case 'anchor':
      return await validateAnchorLink(link, sourceFilePath, headingsByFile);

    case 'external':
      // External URLs are not validated - return info
      return {
        severity: 'info',
        resourcePath: sourceFilePath,
        line: link.line,
        type: 'external_url',
        link: link.href,
        message: 'External URL not validated',
      };

    case 'email':
      // Email links are valid by default
      return null;

    case 'unknown':
      return {
        severity: 'warning',
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
  headingsByFile: Map<string, HeadingNode[]>
): Promise<ValidationIssue | null> {
  // Extract file path and anchor from href
  const [filePath, anchor] = splitHrefAnchor(link.href);

  // Validate the file exists
  const fileResult = await validateLocalFile(filePath, sourceFilePath);

  if (!fileResult.exists) {
    return {
      severity: 'error',
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message: `File not found: ${fileResult.resolvedPath}`,
      suggestion: 'Check that the file path is correct and the file exists',
    };
  }

  // Check if the file is gitignored
  if (fileResult.isGitignored) {
    return {
      severity: 'error',
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_file',
      link: link.href,
      message: `File is gitignored: ${fileResult.resolvedPath}`,
      suggestion:
        'Gitignored files are local-only and will not exist in the repository. Remove this link or unignore the target file.',
    };
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
        severity: 'error',
        resourcePath: sourceFilePath,
        line: link.line,
        type: 'broken_anchor',
        link: link.href,
        message: `Anchor not found: #${anchor} in ${fileResult.resolvedPath}`,
        suggestion: 'Check that the heading exists in the target file',
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
      severity: 'error',
      resourcePath: sourceFilePath,
      line: link.line,
      type: 'broken_anchor',
      link: link.href,
      message: `Anchor not found: ${link.href}`,
      suggestion: 'Check that the heading exists in this file',
    };
  }

  return null;
}


/**
 * Validate that a local file exists and is not gitignored.
 *
 * @param href - The href to the file (relative or absolute)
 * @param sourceFilePath - Absolute path to the source file
 * @returns Object with exists flag, resolved absolute path, and gitignored flag
 *
 * @example
 * ```typescript
 * const result = await validateLocalFile('./docs/guide.md', '/project/README.md');
 * if (result.exists && !result.isGitignored) {
 *   console.log('File exists at:', result.resolvedPath);
 * }
 * ```
 */
async function validateLocalFile(
  href: string,
  sourceFilePath: string
): Promise<{ exists: boolean; resolvedPath: string; isGitignored: boolean }> {
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

  // Check if file is gitignored (only if it exists)
  const gitignored = exists && isGitignored(resolvedPath);

  return { exists, resolvedPath, isGitignored: gitignored };
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
