/**
 * RAGQuery and RAGResult Zod schemas
 */

import { z } from 'zod';

import { RAGChunkSchema } from './chunk.js';

/**
 * RAGQuery Schema
 *
 * Defines the structure of a query to the RAG database.
 */
export const RAGQuerySchema = z.object({
  /** Search query text */
  text: z.string().describe('Search query text'),

  /** Maximum results to return (default: 10) */
  limit: z.number().optional().describe('Maximum results to return'),

  /** Metadata filters */
  filters: z.object({
    /** Filter by resource ID(s) */
    resourceId: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by resource ID(s)'),
    /** Filter by tags */
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    /** Filter by resource type */
    type: z.string().optional().describe('Filter by resource type'),
    /** Filter by heading path */
    headingPath: z.string().optional().describe('Filter by heading path (e.g., "Architecture > RAG Design")'),
    /** Filter by date range */
    dateRange: z.object({
      start: z.date(),
      end: z.date(),
    }).optional().describe('Filter by date range'),
  }).optional().describe('Metadata filters'),

  /** Hybrid search configuration */
  hybridSearch: z.object({
    enabled: z.boolean().describe('Enable hybrid search (vector + keyword)'),
    keywordWeight: z.number().optional().describe('Keyword weight (0-1, balance between semantic and keyword)'),
  }).optional().describe('Hybrid search configuration'),
});

/**
 * RAGQuery TypeScript type
 */
export type RAGQuery = z.infer<typeof RAGQuerySchema>;

/**
 * RAGResult Schema
 *
 * Defines the structure of results from a RAG query.
 */
export const RAGResultSchema = z.object({
  /** Matched chunks, sorted by relevance */
  chunks: z.array(RAGChunkSchema).describe('Matched chunks, sorted by relevance'),

  /** Search statistics */
  stats: z.object({
    totalMatches: z.number().describe('Total number of matches'),
    searchDurationMs: z.number().describe('Search duration in milliseconds'),
    embedding: z.object({
      model: z.string().describe('Embedding model used'),
      tokensUsed: z.number().optional().describe('Tokens used for embedding (if applicable)'),
    }).optional().describe('Embedding statistics'),
  }).describe('Search statistics'),
});

/**
 * RAGResult TypeScript type
 */
export type RAGResult = z.infer<typeof RAGResultSchema>;
