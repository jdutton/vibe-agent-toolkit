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

  /**
   * Metadata filters
   *
   * 🚨 Of the five fields declared below, only `resourceId` reaches a shipped
   * provider. `buildWhereClause` in `@vibe-agent-toolkit/rag-lancedb` branches on
   * `resourceId` and on a `metadata` object — and this schema has no `metadata`
   * key. Everything else here is never destructured by anything, and there is no
   * second provider that reads it.
   *
   * ⚠️ The failure is silent AND it widens rather than narrows. An unread filter
   * contributes no SQL condition; `query()` applies a WHERE clause only when one
   * was produced; so a query filtered solely by an unread field runs as an
   * UNFILTERED full-recall vector search over the whole index — plausible-looking
   * results, no error, no warning.
   *
   * 🔑 The shape providers actually accept is the `RAGQuery` **interface** in
   * `../interfaces/provider.ts`, whose `filters.metadata` is where `tags`, `type`
   * and `headingPath` are honoured. See the "Declared but not implemented"
   * section of `packages/rag-lancedb/README.md`.
   */
  filters: z.object({
    /** Filter by resource ID(s) — the one filter here a shipped provider reads. */
    resourceId: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by resource ID(s)'),
    /**
     * Filter by tags
     *
     * 🚨 Not implemented at this position. Silently ignored by every shipped
     * provider. `tags` is a metadata field: it is honoured only under the
     * `filters.metadata` of the `RAGQuery` interface.
     */
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    /**
     * Filter by resource type
     *
     * 🚨 Not implemented at this position. Silently ignored by every shipped
     * provider. `type` is a metadata field: it is honoured only under the
     * `filters.metadata` of the `RAGQuery` interface.
     */
    type: z.string().optional().describe('Filter by resource type'),
    /**
     * Filter by heading path
     *
     * 🚨 Not implemented at this position. Silently ignored by every shipped
     * provider. `headingPath` is a metadata field: it is honoured only under the
     * `filters.metadata` of the `RAGQuery` interface.
     */
    headingPath: z.string().optional().describe('Filter by heading path (e.g., "Architecture > RAG Design")'),
    /**
     * Filter by date range
     *
     * 🚨 Not implemented ANYWHERE, at any position. No provider has ever read
     * this field and there is no metadata path that rescues it. Silently ignored;
     * a query filtered only by `dateRange` returns the whole index.
     */
    dateRange: z.object({
      start: z.date(),
      end: z.date(),
    }).optional().describe('Filter by date range'),
  }).optional().describe('Metadata filters'),

  /**
   * Hybrid search configuration
   *
   * 🚨 Not implemented by any shipped provider — zero references outside this
   * schema, the `RAGQuery` interface, and their tests. Search is always pure
   * vector search.
   *
   * ⚠️ Silently ignored: setting `enabled: true` produces no keyword pass, no
   * error and no warning. The results are indistinguishable from having omitted
   * the field, so nothing tells a caller that hybrid search did not happen.
   */
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
