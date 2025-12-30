/**
 * Admin-related Zod schemas (RAGStats, IndexResult)
 */

import { z } from 'zod';

/**
 * RAGStats Schema
 *
 * Database statistics for monitoring and debugging.
 */
export const RAGStatsSchema = z.object({
  totalChunks: z.number().describe('Total number of chunks in database'),
  totalResources: z.number().describe('Total number of resources indexed'),
  dbSizeBytes: z.number().describe('Database size in bytes'),
  embeddingModel: z.string().describe('Current embedding model'),
  lastIndexed: z.date().describe('When database was last indexed'),
});

/**
 * RAGStats TypeScript type
 */
export type RAGStats = z.infer<typeof RAGStatsSchema>;

/**
 * IndexResult Schema
 *
 * Result from an indexing operation.
 */
export const IndexResultSchema = z.object({
  resourcesIndexed: z.number().describe('Number of resources newly indexed'),
  resourcesSkipped: z.number().describe('Number of resources skipped (unchanged)'),
  resourcesUpdated: z.number().describe('Number of resources updated (changed)'),
  chunksCreated: z.number().describe('Number of chunks created'),
  chunksDeleted: z.number().describe('Number of chunks deleted'),
  durationMs: z.number().describe('Indexing duration in milliseconds'),
  errors: z.array(z.object({
    resourceId: z.string().describe('Resource ID that failed'),
    error: z.string().describe('Error message'),
  })).optional().describe('Errors that occurred during indexing'),
});

/**
 * IndexResult TypeScript type
 */
export type IndexResult = z.infer<typeof IndexResultSchema>;
