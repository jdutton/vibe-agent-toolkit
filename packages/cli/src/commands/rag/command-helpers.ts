/**
 * Shared helper functions for RAG commands
 */

import type { RAGQueryProvider } from '@vibe-agent-toolkit/rag';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';
import type { Gate } from '@vibe-agent-toolkit/schema';

import type { ReportVerb } from '../../report-schemas.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';
import { requireExistingDatabase } from '../../utils/rag-database.js';

/** No `vat rag` leaf has a `--strict`, and none reports a warning: the gate is fixed. */
export const RAG_GATE: Gate = { strict: false };

/**
 * Resolve database path (explicit flag or default in project)
 * @param explicitDb - Database path from --db flag
 * @param projectRoot - Project root directory (pre-resolved at the CLI boundary)
 * @returns Resolved database path
 * @throws {CommandRefusalError} `USAGE_INVALID` when no path can be determined —
 *   the invocation left out the `--db` it needed
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

  throw new CommandRefusalError('USAGE_INVALID', 'No database path specified and no project root found. Use --db <path>');
}

/**
 * Run `action` on an EXISTING RAG database's path, after checking that it is one.
 *
 * Per CLI-boundary rule (spec §5/§7), `projectRoot` is resolved here using
 * the `tolerate null` policy — null is fine, the existing rag config-loading
 * surface produces its own error if config is required.
 *
 * A failure anywhere — the database path, the action — ends the run as
 * `verb`'s refusal, classified by the thrown value's code (`refusalCodeOf`),
 * never by where it was thrown.
 *
 * @param verb - The report verb running the action, for the refusal document
 * @param options - Command options (db path, debug flag)
 * @param action - What to do with the recognised database path
 * @returns Result of the action
 */
export async function onRagDatabase<T>(
  verb: ReportVerb,
  options: { db?: string; debug?: boolean },
  action: (dbPath: string, logger: Logger) => T | Promise<T>,
): Promise<T> {
  const logger = createLogger({ debug: options.debug ?? false });

  try {
    // Resolve projectRoot at the CLI boundary (`tolerate null` policy).
    const projectRoot = projectRootOrNull(process.cwd());
    const dbPath = resolveDbPath(options.db, projectRoot ?? undefined);
    logger.debug(`Database path: ${dbPath}`);
    requireExistingDatabase(dbPath, options.db !== undefined && options.db !== '');
    return await action(dbPath, logger);
  } catch (error) {
    return endWithRefusal(verb, refusalCodeOf(error), error, 'yaml', RAG_GATE, NOTHING_FINISHED);
  }
}

/**
 * Execute a RAG operation on an EXISTING database, opened, with standard
 * setup/teardown ({@link onRagDatabase}).
 *
 * @param verb - The report verb running the operation, for the refusal document
 * @param options - Command options (db path, debug flag, readonly mode)
 * @param operation - The operation to execute with the RAG provider (given the resolved database path)
 * @returns Result of the operation
 */
export async function executeRagOperation<T>(
  verb: ReportVerb,
  options: { db?: string; debug?: boolean; readonly?: boolean },
  operation: (provider: RAGQueryProvider, logger: Logger, dbPath: string) => Promise<T>,
): Promise<T> {
  return onRagDatabase(verb, options, async (dbPath, logger) => {
    // Create RAG provider (readonly mode by default, can be overridden)
    const ragProvider = await LanceDBRAGProvider.create({
      dbPath,
      readonly: options.readonly ?? true,
    });

    const result = await operation(ragProvider, logger, dbPath);
    await ragProvider.close();
    return result;
  });
}
