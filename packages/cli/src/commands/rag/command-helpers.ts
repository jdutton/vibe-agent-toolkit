/**
 * Shared helper functions for RAG commands
 */

// Re-export shared utilities for convenience
export { formatDuration, handleCommandError as handleRagCommandError } from '../../utils/command-error.js';

/**
 * Resolve database path (explicit flag or default in project)
 * @param explicitDb - Database path from --db flag
 * @param projectRoot - Project root directory (from findProjectRoot)
 * @returns Resolved database path
 * @throws Error if no path can be determined
 */
export function resolveDbPath(
  explicitDb: string | undefined,
  projectRoot: string | undefined
): string {
  if (explicitDb) {
    return explicitDb;
  }

  if (projectRoot) {
    return `${projectRoot}/.rag-db`;
  }

  throw new Error('No database path specified and no project root found. Use --db <path>');
}
