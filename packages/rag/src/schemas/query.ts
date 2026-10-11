/**
 * RAGQuery and RAGResult Zod schemas
 */

import { z } from 'zod';

import { RAGChunkSchema } from './chunk.js';

/**
 * RAGQuery Schema
 *
 * Defines the structure of a query to the RAG database.
 *
 * 🚨 Every object here is `.strict()`, and that is a correctness property rather than
 * tidiness. A default Zod object DELETES an unknown key instead of rejecting it, and for a
 * query object deletion is the widening failure: `filters: { resourceID: 'x' }` — one
 * capital letter off the one filter a shipped provider reads — parsed successfully into
 * `filters: {}`, the provider's allowlist never saw the key, no SQL condition was produced,
 * and `query()` applies a WHERE clause only when one was produced. The result was an
 * unfiltered full-recall search over the entire index. The same typo handed straight to
 * `buildWhereClause` throws, so validating a query against the schema that describes it was
 * the way to LOSE the refusal. `filter` for `filters` at the top level is the same defect
 * one level up, and erases the filtering wholesale.
 *
 * 🔑 The one object left open is `filters.metadata`: its shape is the caller's own metadata
 * schema, which this package cannot know. The provider validates it against that schema and
 * refuses a field the schema does not declare.
 *
 * ⚠️ This changes nothing in the generated `RAGQueryJsonSchema`: `zod-to-json-schema`
 * already emitted `additionalProperties: false` for these objects, so an adopter validating
 * against the published JSON Schema was always told the typo was invalid while VAT's own
 * `safeParse` quietly accepted it. The two halves of one exported contract disagreed; this
 * makes the TypeScript half honour what the JSON half already published.
 */
export const RAGQuerySchema = z.object({
  /** Search query text */
  text: z.string().describe('Search query text'),

  /** Maximum results to return (default: 10) */
  limit: z.number().optional().describe('Maximum results to return'),

  /**
   * Filters
   *
   * 🔑 `resourceId` and `metadata` are the only two keys, and the object is `.strict()`:
   * any other key — `tags`, `type`, `headingPath`, a typo'd `resourceid` — is refused
   * here rather than deleted, because a deleted filter contributes no SQL condition and
   * widens the search to the whole index. Metadata fields are filtered under
   * `filters.metadata` and only there.
   */
  filters: z.object({
    /** Filter by resource ID(s). */
    resourceId: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by resource ID(s)'),
    /**
     * Custom metadata filters, matched against the provider's metadata schema.
     *
     * Left open because the concrete shape is the caller's own metadata schema, which
     * this package cannot know. The provider validates it against that schema.
     */
    metadata: z.record(z.string(), z.unknown()).optional().describe('Custom metadata filters'),
  }).strict().optional().describe('Metadata filters'),
}).strict();

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
    }).strict().optional().describe('Embedding statistics'),
  }).strict().describe('Search statistics'),
}).strict();

/**
 * RAGResult TypeScript type
 */
export type RAGResult = z.infer<typeof RAGResultSchema>;
