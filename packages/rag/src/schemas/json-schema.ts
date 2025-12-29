/**
 * JSON Schema generation from Zod schemas
 *
 * Exports JSON schemas for use by external tools and documentation.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';

import { IndexResultSchema, RAGStatsSchema } from './admin.js';
import { RAGChunkSchema } from './chunk.js';
import { RAGQuerySchema, RAGResultSchema } from './query.js';

/**
 * Generate JSON Schema for RAGChunk
 */
export const RAGChunkJsonSchema = zodToJsonSchema(RAGChunkSchema, {
  name: 'RAGChunk',
  $refStrategy: 'none',
});

/**
 * Generate JSON Schema for RAGQuery
 */
export const RAGQueryJsonSchema = zodToJsonSchema(RAGQuerySchema, {
  name: 'RAGQuery',
  $refStrategy: 'none',
});

/**
 * Generate JSON Schema for RAGResult
 */
export const RAGResultJsonSchema = zodToJsonSchema(RAGResultSchema, {
  name: 'RAGResult',
  $refStrategy: 'none',
});

/**
 * Generate JSON Schema for RAGStats
 */
export const RAGStatsJsonSchema = zodToJsonSchema(RAGStatsSchema, {
  name: 'RAGStats',
  $refStrategy: 'none',
});

/**
 * Generate JSON Schema for IndexResult
 */
export const IndexResultJsonSchema = zodToJsonSchema(IndexResultSchema, {
  name: 'IndexResult',
  $refStrategy: 'none',
});

/**
 * All JSON Schemas exported as a collection
 */
export const jsonSchemas = {
  RAGChunk: RAGChunkJsonSchema,
  RAGQuery: RAGQueryJsonSchema,
  RAGResult: RAGResultJsonSchema,
  RAGStats: RAGStatsJsonSchema,
  IndexResult: IndexResultJsonSchema,
};
