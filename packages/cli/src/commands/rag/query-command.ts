/**
 * RAG query command - search the vector database
 */

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

  // Format chunks with explicit field order: short fields first, content last
  const formattedChunks = result.chunks.map((chunk) => ({
    // Identifiers
    chunkId: chunk.chunkId,
    resourceId: chunk.resourceId,

    // Location metadata (short)
    filePath: chunk.filePath,
    ...(chunk.headingPath ? { headingPath: chunk.headingPath } : {}),
    ...(chunk.headingLevel === undefined ? {} : { headingLevel: chunk.headingLevel }),
    ...(chunk.startLine === undefined ? {} : { startLine: chunk.startLine }),
    ...(chunk.endLine === undefined ? {} : { endLine: chunk.endLine }),

    // Resource metadata (short)
    ...(chunk.title ? { title: chunk.title } : {}),
    ...(chunk.type ? { type: chunk.type } : {}),
    ...(chunk.tags && chunk.tags.length > 0 ? { tags: chunk.tags } : {}),

    // Technical metadata (short)
    contentHash: chunk.contentHash,
    tokenCount: chunk.tokenCount,
    embeddingModel: chunk.embeddingModel,
    embeddedAt: chunk.embeddedAt,

    // Context links (short)
    ...(chunk.previousChunkId ? { previousChunkId: chunk.previousChunkId } : {}),
    ...(chunk.nextChunkId ? { nextChunkId: chunk.nextChunkId } : {}),

    // Content (long, last)
    content: chunk.content,
  }));

  // Output with stats/duration before chunks (short fields first)
  writeYamlOutput({
    status: 'success',
    query: queryText,
    stats: result.stats,
    duration: formatDuration(duration),
    chunks: formattedChunks,
  });

  process.exit(0);
}
