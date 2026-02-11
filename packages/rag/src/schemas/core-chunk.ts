/**
 * Core RAG Chunk Zod schema
 *
 * Defines required fields for RAG functionality.
 */

import { z } from 'zod';

/**
 * CoreRAGChunkSchema
 *
 * Zod schema for core RAG chunk fields.
 * These fields are required for all RAG implementations.
 */
export const CoreRAGChunkSchema = z.object({
  // Identity
  chunkId: z.string().describe('Unique chunk identifier (uuid)'),
  resourceId: z.string().describe('Source resource ID from ResourceRegistry'),

  // Content
  content: z.string().describe('The actual text chunk'),
  contentHash: z.string().describe('Hash of content for change detection'),
  tokenCount: z.number().describe('Accurate token count from TokenCounter'),

  // Position within source document
  chunkIndex: z.number().optional().describe('0-based position of this chunk within the source document'),
  totalChunks: z.number().optional().describe('Total number of chunks for the source document'),

  // Vectors
  embedding: z.array(z.number()).describe('Vector embedding'),
  embeddingModel: z.string().describe('Model used: "text-embedding-3-small", "all-MiniLM-L6-v2", etc.'),
  embeddedAt: z.date().describe('When embedding was generated'),

  // Context linking
  previousChunkId: z.string().optional().describe('Previous chunk in document (for context expansion)'),
  nextChunkId: z.string().optional().describe('Next chunk in document (for context expansion)'),

  // Search result metrics (optional, only present in query results)
  _distance: z.number().optional().describe('Raw distance metric from vector search (lower is more similar)'),
  score: z.number().optional().describe('Computed similarity score 0-1 (higher is more similar)'),
});

/**
 * CoreRAGChunk TypeScript type (inferred from schema)
 */
export type CoreRAGChunk = z.infer<typeof CoreRAGChunkSchema>;
