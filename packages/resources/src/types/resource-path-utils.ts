/**
 * Path utilities for resource management
 *
 * Handles path normalization, validation, and absolutePath computation.
 * All projectPath values must be relative with forward slashes.
 */

import { join, normalize, sep } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * Normalize a path to projectPath format
 *
 * Converts to relative path with forward slashes:
 * - Removes leading /, //, file://, file:///
 * - Converts backslashes to forward slashes
 * - Preserves relative path structure (including ../)
 *
 * @param path - Path to normalize
 * @returns Normalized projectPath (relative, forward slashes)
 */
export function normalizeProjectPath(path: string): string {
  let normalized = path;

  // Remove file:// or file:/// protocol
  normalized = normalized.replace(/^file:\/\/\/?/, '');

  // Convert to forward slashes first (handles Windows backslashes)
  normalized = toForwardSlash(normalized);

  // Remove leading / or // (after converting backslashes)
  normalized = normalized.replace(/^\/+/, '');

  return normalized;
}

/**
 * Validate that a projectPath is safe and relative
 *
 * Requirements:
 * - Must be relative (no leading /, //, C:/, etc.)
 * - Must use forward slashes only (no backslashes)
 * - Must not escape project root with ../
 * - Must not be a URL (http://, https://, file://)
 * - Must not be empty
 *
 * @param projectPath - Path to validate
 * @returns true if valid projectPath
 */
export function isValidProjectPath(projectPath: string): boolean {
  if (!projectPath) {
    return false;
  }

  // Reject absolute paths (leading slash or drive letter)
  if (projectPath.startsWith('/') || /^[A-Za-z]:/.test(projectPath)) {
    return false;
  }

  // Reject URLs
  if (projectPath.startsWith('http://') || projectPath.startsWith('https://') || projectPath.startsWith('file://')) {
    return false;
  }

  // Reject backslashes (must use forward slashes)
  if (projectPath.includes('\\')) {
    return false;
  }

  // Reject paths that escape project root
  // Normalize the path and check if it starts with ../
  const normalized = normalize(projectPath);
  const parts = normalized.split(sep);
  let depth = 0;

  for (const part of parts) {
    if (part === '..') {
      depth--;
      if (depth < 0) {
        return false; // Escaped project root
      }
    } else if (part !== '.' && part !== '') {
      depth++;
    }
  }

  return true;
}

/**
 * Compute absolute path from project root and projectPath
 *
 * This is a runtime utility - absolutePath should never be serialized.
 *
 * @param projectRoot - Absolute path to project root
 * @param projectPath - Relative path from project root
 * @returns Absolute path to resource
 */
export function getResourceAbsolutePath(projectRoot: string, projectPath: string): string {
  return join(projectRoot, projectPath);
}
