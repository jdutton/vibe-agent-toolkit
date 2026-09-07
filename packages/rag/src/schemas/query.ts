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
   * Metadata filters
   *
   * 🔑 `resourceId` and `metadata` are the only two keys a shipped provider reads:
   * `buildWhereClause` in `@vibe-agent-toolkit/rag-lancedb` branches on exactly
   * those and destructures nothing else.
   *
   * ⛔ The other four remain declared because they are part of VAT's published query
   * surface, and every shipped provider now **throws** on them rather than dropping
   * them. They are refused rather than ignored because ignoring them WIDENS: an
   * unread filter contributes no SQL condition, and `query()` applies a WHERE clause
   * only when one was produced, so a query filtered solely by an unread field used to
   * run as an UNFILTERED full-recall vector search over the whole index —
   * plausible-looking results drawn from exactly the documents the filter was meant
   * to exclude, with no error and no warning. A RAG filter is usually a correctness
   * or access boundary, which puts the silent version closer to a data-exposure
   * defect than to a missing feature.
   *
   * ⚠️ This schema validates STRUCTURE, not provider support: a query carrying one of
   * the four DECLARED-BUT-UNIMPLEMENTED keys parses successfully here and is refused at
   * `query()`. The refusal names the offending key and its remedy — see
   * `assertQuerySupported`, which lives in and is exported from this package.
   *
   * A key this object does NOT declare is a different case and is refused right here, by
   * `.strict()`: it would otherwise be deleted before any provider could refuse it, which
   * is the widening defect described on the schema above.
   */
  filters: z.object({
    /** Filter by resource ID(s) — one of the two filters a shipped provider reads. */
    resourceId: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by resource ID(s)'),
    /**
     * Custom metadata filters, matched against the provider's metadata schema.
     *
     * 🔑 This is the position at which `tags`, `type` and `headingPath` ARE honoured,
     * and it is the remedy every top-level refusal below points at — so it has to be
     * expressible here. It was previously absent from this schema entirely, and a Zod
     * object strips unknown keys rather than rejecting them, so a `filters.metadata`
     * supplied to a schema-validated query was silently discarded before it could
     * reach a provider: the one filter path that works was the one path this schema
     * could not express.
     *
     * Left open because the concrete shape is the caller's own metadata schema, which
     * this package cannot know. The provider validates it against that schema.
     */
    metadata: z.record(z.string(), z.unknown()).optional().describe('Custom metadata filters'),
    /**
     * Filter by tags
     *
     * ⛔ Unsupported at this position — a shipped provider THROWS. `tags` is a
     * metadata field: it is honoured under `filters.metadata.tags` and only there.
     */
    tags: z.array(z.string()).optional().describe('Filter by tags (unsupported here — use filters.metadata.tags)'),
    /**
     * Filter by resource type
     *
     * ⛔ Unsupported at this position — a shipped provider THROWS. `type` is a
     * metadata field: it is honoured under `filters.metadata.type` and only there.
     */
    type: z.string().optional().describe('Filter by resource type (unsupported here — use filters.metadata.type)'),
    /**
     * Filter by heading path
     *
     * ⛔ Unsupported at this position — a shipped provider THROWS. `headingPath` is a
     * metadata field: it is honoured under `filters.metadata.headingPath`, only there.
     */
    headingPath: z.string().optional().describe('Filter by heading path (unsupported here — use filters.metadata.headingPath)'),
    /**
     * Filter by date range
     *
     * ⛔ Implemented at NO position by any provider — a shipped provider THROWS, and
     * no metadata path rescues it. Model the date as a field on your own metadata
     * schema and filter via `filters.metadata`, or filter the returned chunks
     * yourself.
     */
    dateRange: z.object({
      /**
       * 🚨 `z.coerce.date()`, not `z.date()`, and the coercion IS the contract.
       *
       * `zod-to-json-schema` emits `{"type":"string","format":"date-time"}` for a Zod date,
       * so the published `RAGQueryJsonSchema` tells every adopter that an ISO-8601 string is
       * the correct value — and since JSON carries no date type, a string is the only value
       * that CAN cross a wire. A bare `z.date()` then rejected exactly that string with
       * `invalid_type`, so a payload validating against VAT's own published schema failed
       * VAT's own `safeParse`: the two halves of one exported contract disagreed on the only
       * representation either of them could actually receive, and the adopter who followed
       * the published schema was the one who got the error.
       *
       * Coercing keeps the emitted JSON Schema byte-identical while making the TypeScript
       * half accept what the JSON half publishes, and a consumer reads a `Date` either way
       * rather than branching on how the query arrived. A string that is not a date still
       * fails: `new Date('last Tuesday')` is `Invalid Date`, which `ZodDate` refuses.
       */
      start: z.coerce.date(),
      end: z.coerce.date(),
    }).strict().optional().describe('Filter by date range (unsupported by every provider)'),
  }).strict().optional().describe('Metadata filters'),

  /**
   * Hybrid search configuration
   *
   * ⛔ Implemented by no shipped provider — `enabled: true` THROWS. Search is always
   * pure vector search.
   *
   * It is refused rather than ignored for the same reason as the filters above, in a
   * sharper form: the results of an ignored `enabled: true` are indistinguishable
   * from having omitted the field entirely, so nothing whatsoever would tell a caller
   * that the keyword pass never ran. Pass `enabled: false`, or omit the field, to run
   * the vector search deliberately — and drop any `keywordWeight` with it: a weight
   * reaches no keyword pass either, so it is refused even when `enabled` is `false`.
   */
  hybridSearch: z.object({
    enabled: z.boolean().describe('Enable hybrid search (vector + keyword) — true is refused; no provider implements it'),
    keywordWeight: z.number().optional().describe('Keyword weight (0-1, balance between semantic and keyword)'),
  }).strict().optional().describe('Hybrid search configuration'),
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
    }).optional().describe('Embedding statistics'),
  }).describe('Search statistics'),
});

/**
 * RAGResult TypeScript type
 */
export type RAGResult = z.infer<typeof RAGResultSchema>;
