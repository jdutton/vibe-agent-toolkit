/**
 * Shared helper functions for RAG commands
 */

import type { RAGQueryProvider } from '@vibe-agent-toolkit/rag';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

import { createLogger, type Logger } from '../../utils/logger.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';

// Re-export shared utilities for convenience
export { formatDuration, handleCommandError } from '../../utils/command-error.js';

/**
 * Resolve database path (explicit flag or default in project)
 * @param explicitDb - Database path from --db flag
 * @param projectRoot - Project root directory (pre-resolved at the CLI boundary)
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

/**
 * Execute a RAG operation with standard setup/teardown pattern.
 *
 * Per CLI-boundary rule (spec §5/§7), `projectRoot` is resolved here using
 * the `tolerate null` policy — null is fine, the existing rag config-loading
 * surface produces its own error if config is required.
 *
 * @param options - Command options (db path, debug flag, readonly mode)
 * @param operation - The operation to execute with the RAG provider
 * @param commandName - Name of the command (for error reporting)
 * @returns Result of the operation
 */
export async function executeRagOperation<T>(
  options: { db?: string; debug?: boolean; readonly?: boolean },
  operation: (provider: RAGQueryProvider, logger: Logger) => Promise<T>,
  commandName: string
): Promise<T> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    // Resolve projectRoot at the CLI boundary (`tolerate null` policy).
    const projectRoot = projectRootOrNull(process.cwd());
    const dbPath = resolveDbPath(options.db, projectRoot ?? undefined);
    logger.debug(`Database path: ${dbPath}`);

    // Create RAG provider (readonly mode by default, can be overridden)
    const ragProvider = await LanceDBRAGProvider.create({
      dbPath,
      readonly: options.readonly ?? true,
    });

    // Execute operation
    const result = await operation(ragProvider, logger);

    // Close provider
    await ragProvider.close();

    return result;
  } catch (error) {
    // Use handleCommandError from re-export
    const { handleCommandError } = await import('../../utils/command-error.js');
    handleCommandError(error, logger, startTime, commandName);
    throw error; // Never reached due to process.exit in handleCommandError
  }
}
