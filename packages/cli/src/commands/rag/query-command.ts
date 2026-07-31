/**
 * RAG query command - search the vector database
 */

import { safePath } from '@vibe-agent-toolkit/utils';

import { writeYamlOutput } from '../../utils/output.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';
import { relativizePath } from '../../utils/relativize-paths.js';

import { executeRagOperation, formatDuration } from './command-helpers.js';

interface QueryOptions {
  db?: string;
  limit?: number;
  debug?: boolean;
}

/** The chunk fields this payload republishes. Structural, so tests can pass a literal. */
interface QueriedChunk {
  chunkId: string;
  resourceId: string;
  filePath: string;
  headingPath?: string | undefined;
  headingLevel?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  title?: string | undefined;
  type?: string | undefined;
  tags?: string[] | undefined;
  contentHash: string;
  tokenCount: number;
  embeddingModel: string;
  embeddedAt: Date;
  previousChunkId?: string | undefined;
  nextChunkId?: string | undefined;
  content: string;
}

export interface QueryPayloadInput {
  queryText: string;
  chunks: readonly QueriedChunk[];
  stats: unknown;
  durationMs: number;
  /** The stated root: the ONE base every reported path is relative to. */
  root: string;
}

/**
 * Build the query payload.
 *
 * `resourceId` is already relative — the registry derives it from the indexing
 * base — so an absolute `filePath` one line above it put a single record in two
 * coordinate systems, and leaked `$HOME` into every result. Re-basing happens
 * once, here, so both identifiers read the same way.
 *
 * Fields are ordered deliberately: short ones first, `content` last, so a long
 * result stays scannable.
 */
export function buildQueryOutputData(input: QueryPayloadInput): Record<string, unknown> {
  const { queryText, chunks, stats, durationMs, root } = input;

  const formattedChunks = chunks.map((chunk) => ({
    // Identifiers
    chunkId: chunk.chunkId,
    resourceId: chunk.resourceId,

    // Location metadata (short)
    filePath: relativizePath(chunk.filePath, root),
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

  // Stats/duration before chunks (short fields first)
  return {
    status: 'success',
    root,
    query: queryText,
    stats,
    duration: formatDuration(durationMs),
    chunks: formattedChunks,
  };
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

  // The index lives under the project (`<projectRoot>/.rag-db` by default) and
  // its `resourceId`s are already project-relative, so projectRoot is the base
  // that puts `filePath` in the same coordinate system.
  const root = projectRootOrNull(process.cwd()) ?? safePath.resolve(process.cwd());

  writeYamlOutput(
    buildQueryOutputData({
      queryText,
      chunks: result.chunks,
      stats: result.stats,
      durationMs: Date.now() - startTime,
      root,
    })
  );

  process.exit(0);
}
