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

  // Vectors
  embedding: z.array(z.number()).describe('Vector embedding'),
  embeddingModel: z.string().describe('Model used: "text-embedding-3-small", "all-MiniLM-L6-v2", etc.'),
  embeddedAt: z.date().describe('When embedding was generated'),

  // Context linking
  previousChunkId: z.string().optional().describe('Previous chunk in document (for context expansion)'),
  nextChunkId: z.string().optional().describe('Next chunk in document (for context expansion)'),
});

/**
 * CoreRAGChunk TypeScript type (inferred from schema)
 */
export type CoreRAGChunk = z.infer<typeof CoreRAGChunkSchema>;
