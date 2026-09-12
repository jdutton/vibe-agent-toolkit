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

/** A whole, non-negative count — what every `IndexResult` counter is. */
const count = (description: string) => z.number().int().nonnegative().describe(description);

/**
 * IndexResult Schema
 *
 * Result from an indexing operation. This is the ONE definition of the shape;
 * the provider interface's `IndexResult` is inferred from it, so the counters,
 * their descriptions and the published JSON Schema cannot drift apart.
 *
 * Every resource in the batch lands in exactly one of `resourcesIndexed`,
 * `resourcesSkipped`, `resourcesEmpty` or `errors`. `resourcesUpdated` is not a
 * fifth bucket: it counts resources whose previous chunks were deleted because
 * their content changed, and each of those is ALSO indexed (new chunks written)
 * or empty (the new content has no prose).
 *
 * Strict: a field the shape does not declare is refused rather than passed
 * through, and a counter is a whole non-negative number or it is refused.
 */
export const IndexResultSchema = z.object({
  resourcesIndexed: count('Resources that had chunks written this run — new content and changed (updated) content alike'),
  resourcesSkipped: count('Resources left untouched because their content hash matched the index'),
  resourcesUpdated: count('Resources whose previous chunks were deleted because their content changed; each is also counted in resourcesIndexed or resourcesEmpty'),
  resourcesEmpty: count('Resources that chunked to nothing (frontmatter-only or blank); not an error, not indexed, and not skipped'),
  chunksCreated: count('Chunks written this run'),
  chunksDeleted: count('Chunks removed this run, all belonging to resourcesUpdated'),
  durationMs: count('Wall-clock time for the whole batch, in milliseconds'),
  errors: z.array(z.object({
    resourceId: z.string().describe('Resource ID that failed'),
    error: z.string().describe('Error message'),
  }).strict()).optional().describe('Resources that could not be indexed, with the reason for each'),
}).strict();

/**
 * IndexResult TypeScript type
 */
export type IndexResult = z.infer<typeof IndexResultSchema>;
