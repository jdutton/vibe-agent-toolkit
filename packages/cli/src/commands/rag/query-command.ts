/**
 * RAG query command - search the vector database
 */

import type { RAGChunk } from '@vibe-agent-toolkit/rag';

import { writeYamlOutput } from '../../utils/output.js';

import { executeRagOperation, formatDuration } from './command-helpers.js';

interface QueryOptions {
  db?: string;
  limit?: number;
  debug?: boolean;
}

export async function queryCommand(
  queryText: string,
  options: QueryOptions
): Promise<void> {
  const startTime = Date.now();

  const result = await executeRagOperation(
    options,
    async (ragProvider, logger) => {
      logger.debug(`Querying for: "${queryText}"`);

      // Execute query
      const queryResult = await ragProvider.query({
        text: queryText,
        limit: options.limit ?? 10,
      });

      return queryResult;
    },
    'Query'
  );

  const duration = Date.now() - startTime;

  // Format results with truncated content
  const results = result.chunks.map((chunk: RAGChunk, index: number) => ({
    rank: index + 1,
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
    totalMatches: result.stats.totalMatches,
    searchDurationMs: result.stats.searchDurationMs,
    embeddingModel: result.stats.embedding?.model,
    results,
    duration: formatDuration(duration),
  });

  process.exit(0);
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
