/**
 * RAG query command - search the vector database
 */

import { buildReport } from '@vibe-agent-toolkit/schema';
import { RAG_INDEX_EMPTY_CODE, safePath, VatError } from '@vibe-agent-toolkit/utils';

import { endWithReport } from '../../utils/document-writer.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';
import { relativizePath } from '../../utils/relativize-paths.js';

import { executeRagOperation, RAG_GATE } from './command-helpers.js';
import type { RagQueryData, RagQueryReport } from './query-schema.js';

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
  stats: RagQueryData['stats'];
  /** The stated root: the ONE base every reported path is relative to. */
  root: string;
}

/**
 * Build the query `data`.
 *
 * `resourceId` is already relative — the registry derives it from the indexing
 * base — so an absolute `filePath` one line above it put a single record in two
 * coordinate systems, and leaked `$HOME` into every result. Re-basing happens
 * once, here, so both identifiers read the same way.
 *
 * Fields are ordered deliberately: short ones first, `content` last, so a long
 * result stays scannable.
 */
export function buildQueryOutputData(input: QueryPayloadInput): RagQueryData {
  const { queryText, chunks, stats, root } = input;

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
    embeddedAt: chunk.embeddedAt.toISOString(),

    // Context links (short)
    ...(chunk.previousChunkId ? { previousChunkId: chunk.previousChunkId } : {}),
    ...(chunk.nextChunkId ? { nextChunkId: chunk.nextChunkId } : {}),

    // Content (long, last)
    content: chunk.content,
  }));

  // Stats before chunks (short fields first)
  return { root, query: queryText, stats, chunks: formattedChunks };
}

/**
 * Refuse an index that holds no chunk, as the provider refuses one with no table.
 *
 * "Nothing indexed" reaches this command two ways — a database with no chunk
 * table (the provider's query throws `RAG_INDEX_EMPTY`) and a table holding
 * zero chunks (the query would return nothing, and the writer's zero-examined
 * refusal would publish a finding at exit 1). One situation, one outcome: the
 * same code, which the refusal map reads as INPUT_UNREADABLE (exit 2).
 *
 * @param totalChunks - Chunks in the index, from the provider's stats
 * @param dbPath - The database, for the message
 * @throws {VatError} `RAG_INDEX_EMPTY` when the index holds no chunk
 */
export function assertIndexHoldsChunks(totalChunks: number, dbPath: string): void {
  if (totalChunks > 0) return;
  throw new VatError(
    RAG_INDEX_EMPTY_CODE,
    `No data indexed yet: the index at ${dbPath} holds no chunk to search. Run vat rag index first, and check its findings for documents that failed.`,
  );
}

export async function queryCommand(
  queryText: string,
  options: QueryOptions
): Promise<void> {
  const startTime = Date.now();

  const { result, indexedChunks } = await executeRagOperation(
    'rag query',
    options,
    async (ragProvider, logger, dbPath) => {
      // `examined` is what was searched — the index — so a query that matches
      // nothing over a populated index is a clean answer, not an empty run.
      // Asked BEFORE the query, so an empty index refuses one way however it is empty.
      const { totalChunks } = await ragProvider.getStats();
      assertIndexHoldsChunks(totalChunks, dbPath);

      logger.debug(`Querying for: "${queryText}"`);
      const queryResult = await ragProvider.query({
        text: queryText,
        limit: options.limit ?? 10,
      });

      return { result: queryResult, indexedChunks: totalChunks };
    },
  );

  // The index lives under the project (`<projectRoot>/.rag-db` by default) and
  // its `resourceId`s are already project-relative, so projectRoot is the base
  // that puts `filePath` in the same coordinate system.
  const root = projectRootOrNull(process.cwd()) ?? safePath.resolve(process.cwd());

  const report: RagQueryReport = buildReport({
    examined: indexedChunks,
    findings: [],
    data: buildQueryOutputData({ queryText, chunks: result.chunks, stats: result.stats, root }),
    gate: RAG_GATE,
    durationMs: Date.now() - startTime,
  });
  endWithReport('rag query', report, 'yaml');
}
