/**
 * RAGChunk Zod schema
 *
 * Defines the structure of a chunk in the RAG database.
 */

import { z } from 'zod';

/**
 * RAGChunk Schema
 *
 * Rich metadata schema for RAG chunks, enabling filtered searches
 * and context expansion.
 */
export const RAGChunkSchema = z.object({
  // Identity
  chunkId: z.string().describe('Unique chunk identifier (uuid)'),
  resourceId: z.string().describe('Source resource ID from ResourceRegistry'),

  // Content
  content: z.string().describe('The actual text chunk'),
  contentHash: z.string().describe('Hash of content for change detection'),
  tokenCount: z.number().describe('Accurate token count from TokenCounter'),

  // Structure (from markdown parsing)
  headingPath: z.string().optional().describe('Full heading hierarchy: "Architecture > RAG Design"'),
  headingLevel: z.number().optional().describe('Heading level (1-6) if chunk is under a heading'),
  startLine: z.number().optional().describe('Starting line number in source file'),
  endLine: z.number().optional().describe('Ending line number in source file'),

  // Resource metadata (from ResourceRegistry - may be from frontmatter, inference, defaults, or config)
  filePath: z.string().describe('Source file path'),
  tags: z.array(z.string()).optional().describe('Resource tags'),
  type: z.string().optional().describe('Resource type'),
  title: z.string().optional().describe('Resource title'),

  // Embedding metadata
  embedding: z.array(z.number()).describe('Vector embedding'),
  embeddingModel: z.string().describe('Model used: "text-embedding-3-small", "all-MiniLM-L6-v2", etc.'),
  embeddedAt: z.date().describe('When embedding was generated'),

  // Context (for retrieval)
  previousChunkId: z.string().optional().describe('Previous chunk in document (for context)'),
  nextChunkId: z.string().optional().describe('Next chunk in document (for context)'),
});

/**
 * RAGChunk TypeScript type (inferred from schema)
 */
export type RAGChunk = z.infer<typeof RAGChunkSchema>;
