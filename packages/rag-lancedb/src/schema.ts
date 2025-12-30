/**
 * LanceDB schema mapping
 *
 * Converts between RAGChunk and LanceDB row format.
 */

import type { RAGChunk } from '@vibe-agent-toolkit/rag';

/**
 * LanceDB row format
 *
 * LanceDB stores data in Apache Arrow format with specific type requirements.
 * Must have index signature for LanceDB compatibility.
 *
 * Note: LanceDB/Arrow cannot infer array types if all values are null,
 * so we use empty arrays instead of null for array fields.
 */
export interface LanceDBRow extends Record<string, unknown> {
  // Required by LanceDB for vector search
  vector: number[];

  // RAGChunk fields
  chunkId: string;
  resourceId: string;
  content: string;
  contentHash: string; // Hash of chunk content
  resourceContentHash: string; // Hash of full resource content (for change detection)
  tokenCount: number;

  // Structure (nullable - use empty string for Arrow compatibility)
  headingPath: string;
  headingLevel: number | null;
  startLine: number | null;
  endLine: number | null;

  // Resource metadata (use empty strings for Arrow compatibility)
  filePath: string;
  tags: string; // Comma-separated string
  type: string; // Empty string if not set
  title: string; // Empty string if not set

  // Embedding metadata
  embeddingModel: string;
  embeddedAt: number; // Unix timestamp

  // Context (use empty strings for Arrow compatibility)
  previousChunkId: string;
  nextChunkId: string;
}

/**
 * Convert RAGChunk to LanceDB row format
 *
 * @param chunk - RAGChunk to convert
 * @param resourceContentHash - Hash of the full resource content (for change detection)
 * @returns LanceDB row
 */
export function chunkToLanceRow(chunk: RAGChunk, resourceContentHash: string): LanceDBRow {
  return {
    vector: chunk.embedding,
    chunkId: chunk.chunkId,
    resourceId: chunk.resourceId,
    content: chunk.content,
    contentHash: chunk.contentHash,
    resourceContentHash,
    tokenCount: chunk.tokenCount,
    headingPath: chunk.headingPath ?? '', // Empty string for Arrow
    headingLevel: chunk.headingLevel ?? null,
    startLine: chunk.startLine ?? null,
    endLine: chunk.endLine ?? null,
    filePath: chunk.filePath,
    tags: chunk.tags?.join(',') ?? '', // Convert array to comma-separated string
    type: chunk.type ?? '', // Empty string for Arrow
    title: chunk.title ?? '', // Empty string for Arrow
    embeddingModel: chunk.embeddingModel,
    embeddedAt: chunk.embeddedAt.getTime(),
    previousChunkId: chunk.previousChunkId ?? '', // Empty string for Arrow
    nextChunkId: chunk.nextChunkId ?? '', // Empty string for Arrow
  };
}

/**
 * Convert LanceDB row to RAGChunk
 *
 * @param row - LanceDB row
 * @returns RAGChunk
 */
export function lanceRowToChunk(row: LanceDBRow): RAGChunk {
  const chunk: RAGChunk = {
    chunkId: row.chunkId,
    resourceId: row.resourceId,
    content: row.content,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount,
    filePath: row.filePath,
    embedding: row.vector,
    embeddingModel: row.embeddingModel,
    embeddedAt: new Date(row.embeddedAt),
  };

  // Only add optional properties if they exist (non-empty strings)
  if (row.headingPath && row.headingPath.length > 0) chunk.headingPath = row.headingPath;
  if (row.headingLevel !== null) chunk.headingLevel = row.headingLevel;
  if (row.startLine !== null) chunk.startLine = row.startLine;
  if (row.endLine !== null) chunk.endLine = row.endLine;
  if (row.tags && row.tags.length > 0) {
    chunk.tags = row.tags.split(','); // Convert comma-separated string back to array
  }
  if (row.type && row.type.length > 0) chunk.type = row.type;
  if (row.title && row.title.length > 0) chunk.title = row.title;
  if (row.previousChunkId && row.previousChunkId.length > 0) chunk.previousChunkId = row.previousChunkId;
  if (row.nextChunkId && row.nextChunkId.length > 0) chunk.nextChunkId = row.nextChunkId;

  return chunk;
}
