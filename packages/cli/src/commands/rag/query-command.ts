/**
 * RAG query command - search the vector database
 */

import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { findProjectRoot } from '../../utils/project-root.js';

import { formatDuration, handleRagCommandError, resolveDbPath } from './command-helpers.js';

interface QueryOptions {
  db?: string;
  limit?: number;
  debug?: boolean;
}

export async function queryCommand(
  queryText: string,
  options: QueryOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    // Resolve database path
    const projectRoot = findProjectRoot(process.cwd());
    const dbPath = resolveDbPath(options.db, projectRoot ?? undefined);
    logger.debug(`Database path: ${dbPath}`);

    // Create RAG provider in readonly mode
    const ragProvider = await LanceDBRAGProvider.create({
      dbPath,
      readonly: true,
    });

    // Execute query
    const queryResult = await ragProvider.query({
      text: queryText,
      limit: options.limit ?? 10,
    });

    // Close provider
    await ragProvider.close();

    const duration = Date.now() - startTime;

    // Format results with truncated content
    const results = queryResult.chunks.map((chunk, index) => ({
      rank: index + 1,
      score: chunk.embedding ? chunk.embedding[0] : 0, // Use first embedding dimension as score placeholder
      resourceId: chunk.resourceId,
      filePath: chunk.filePath,
      content: truncateContent(chunk.content, 200),
      ...(chunk.headingPath ? { headingPath: chunk.headingPath } : {}),
      ...(chunk.title ? { title: chunk.title } : {}),
    }));

    // Output results as YAML
    writeYamlOutput({
      status: 'success',
      query: queryText,
      totalMatches: queryResult.stats.totalMatches,
      searchDurationMs: queryResult.stats.searchDurationMs,
      embeddingModel: queryResult.stats.embedding?.model,
      results,
      duration: formatDuration(duration),
    });

    process.exit(0);
  } catch (error) {
    handleRagCommandError(error, logger, startTime, 'Query');
  }
}

/**
 * Truncate content to max length with ellipsis
 */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + '...';
}
