/**
 * RAGChunk Zod schema
 *
 * Backward-compatible schema combining CoreRAGChunkSchema + DefaultRAGMetadataSchema.
 */

import type { z } from 'zod';

import { CoreRAGChunkSchema } from './core-chunk.js';
import { DefaultRAGMetadataSchema } from './default-metadata.js';

/**
 * RAGChunkSchema
 *
 * Standard RAG chunk schema with default metadata.
 * Composed from CoreRAGChunkSchema + DefaultRAGMetadataSchema.
 */
export const RAGChunkSchema = CoreRAGChunkSchema.merge(DefaultRAGMetadataSchema);

/**
 * RAGChunk TypeScript type (inferred from schema)
 */
export type RAGChunk = z.infer<typeof RAGChunkSchema>;

/**
 * Helper function to create custom RAG chunk schemas
 *
 * @param metadataSchema - Custom metadata schema
 * @returns Merged schema (CoreRAGChunk + custom metadata)
 *
 * @example
 * const MyMetadataSchema = z.object({
 *   domain: z.string(),
 *   category: z.string().optional(),
 * });
 *
 * const MyChunkSchema = createCustomRAGChunkSchema(MyMetadataSchema);
 * type MyChunk = z.infer<typeof MyChunkSchema>;
 */
export function createCustomRAGChunkSchema<T extends z.ZodRawShape>(
  metadataSchema: z.ZodObject<T>
): z.ZodObject<z.objectUtil.extendShape<typeof CoreRAGChunkSchema.shape, T>> {
  return CoreRAGChunkSchema.merge(metadataSchema);
}
