/**
 * Tests for RAGQuery and RAGResult schemas
 */

import { describe, it, expect } from 'vitest';

import { RAGQueryJsonSchema } from '../../src/schemas/json-schema.js';
import { RAGQuerySchema, RAGResultSchema } from '../../src/schemas/query.js';
import type { RAGQuery, RAGResult } from '../../src/schemas/query.js';

const TEST_SEARCH_TERM = 'search term';

describe('RAGQuerySchema', () => {
  it('should validate minimal query with just text', () => {
    const query: RAGQuery = {
      text: 'How do I validate schemas?',
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe('How do I validate schemas?');
    }
  });

  it('should validate query with limit', () => {
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      limit: 10,
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  /**
   * ⚠️ Parsing is not support. This schema validates STRUCTURE; whether a provider
   * can honour a field is a separate question, answered by
   * `assertFiltersAreSupported` in `@vibe-agent-toolkit/rag-lancedb` and pinned by
   * that package's `unsupported-filters` / `unsupported-query` suites.
   *
   * `tags`, `type`, `headingPath` and `hybridSearch.enabled: true` all parse here and
   * are all REFUSED at `query()`. Do not read a green assertion below as evidence that
   * one of them works — this file never constructs a provider, so it is structurally
   * incapable of seeing that a filtered query returned the whole corpus. That blindness
   * is exactly how the widening defect survived a green suite.
   */
  it('should validate query with filters', () => {
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      filters: {
        resourceId: 'resource-123',
        tags: ['validation', 'schema'],
        type: 'documentation',
        headingPath: 'Architecture > RAG',
      },
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters?.tags).toEqual(['validation', 'schema']);
      expect(result.data.filters?.type).toBe('documentation');
    }
  });

  it('should preserve filters.metadata rather than stripping it', () => {
    // A Zod object strips unknown keys instead of rejecting them, so before this
    // schema declared `metadata`, the ONE filter path a provider honours was silently
    // discarded by validating against the schema that is supposed to describe it.
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      filters: { metadata: { domain: 'security', priority: 1 } },
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters?.metadata).toEqual({ domain: 'security', priority: 1 });
    }
  });

  it('should validate query with hybridSearch config', () => {
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      hybridSearch: {
        enabled: true,
        keywordWeight: 0.3,
      },
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hybridSearch?.enabled).toBe(true);
      expect(result.data.hybridSearch?.keywordWeight).toBeCloseTo(0.3, 10);
    }
  });

  it('should reject query with missing text', () => {
    const query = {
      limit: 10,
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(false);
  });
});

/**
 * A key this schema does not declare must be REFUSED, never stripped.
 *
 * 🚨 This is the widening defect, reached through VAT's own validation path rather than
 * through a provider. A Zod object DELETES unknown keys, so `filters: { resourceID: 'x' }`
 * — one capital letter off the one filter a provider reads — parsed successfully into
 * `filters: {}`. The provider's allowlist never saw the key, `buildWhereClause` produced no
 * condition, and `query()` applies a WHERE clause only when one was produced: the query ran
 * as an unfiltered full-recall search over the entire index. The same typo handed straight
 * to `buildWhereClause` throws — so validating against the schema that describes the surface
 * was the way to LOSE the refusal.
 */
describe('RAGQuerySchema refuses unknown keys rather than erasing them', () => {
  it('rejects a typo on the one filter key a provider reads', () => {
    // One capital letter from `resourceId`. This used to parse to `filters: {}`.
    const result = RAGQuerySchema.safeParse({ text: TEST_SEARCH_TERM, filters: { resourceID: 'abc-123' } });

    expect(result.success).toBe(false);
  });

  it('names the offending filter key, so the caller can fix the spelling', () => {
    const result = RAGQuerySchema.safeParse({ text: TEST_SEARCH_TERM, filters: { resourceID: 'abc-123' } });
    const issues = result.success ? [] : result.error.issues;

    expect(JSON.stringify(issues)).toMatch(/resourceID/);
  });

  it('rejects a singular `filter`, which silently erased EVERY filter', () => {
    // The top-level instance of the same defect, and the worst one: the entire filter
    // object vanishes and the query searches the whole index.
    const result = RAGQuerySchema.safeParse({ text: TEST_SEARCH_TERM, filter: { resourceId: 'abc-123' } });

    expect(result.success).toBe(false);
  });

  it('rejects a typo inside hybridSearch', () => {
    const result = RAGQuerySchema.safeParse({
      text: TEST_SEARCH_TERM,
      hybridSearch: { enabled: false, keywordWieght: 0.3 },
    });

    expect(result.success).toBe(false);
  });

  it("still accepts arbitrary keys under filters.metadata, which is the caller's own schema", () => {
    // Strictness stops at `metadata`: its shape belongs to the caller's metadata schema,
    // which this package cannot know. The provider validates it against that schema and
    // throws on a field the schema does not declare.
    const result = RAGQuerySchema.safeParse({
      text: TEST_SEARCH_TERM,
      filters: { metadata: { anythingTheCallerDeclared: 'value' } },
    });

    expect(result.success).toBe(true);
  });

  it('agrees with the JSON Schema it publishes, which already refused this key', () => {
    // 🔑 The two halves of one exported contract had opposite verdicts. `zod-to-json-schema`
    // emits `additionalProperties: false` for a plain object, so an adopter validating
    // against the published `RAGQueryJsonSchema` has always been TOLD the typo is invalid —
    // while VAT's own `safeParse` accepted it and deleted the key. The strictness below is
    // what makes the TypeScript path honour the contract the JSON path already published;
    // the emitted JSON Schema is byte-identical either way.
    const schema = RAGQueryJsonSchema as {
      definitions: {
        RAGQuery: { additionalProperties: boolean; properties: { filters: { additionalProperties: boolean } } };
      };
    };
    const typo = { text: TEST_SEARCH_TERM, filters: { resourceID: 'abc-123' } };

    expect(schema.definitions.RAGQuery.properties.filters.additionalProperties).toBe(false);
    expect(schema.definitions.RAGQuery.additionalProperties).toBe(false);
    expect(RAGQuerySchema.safeParse(typo).success).toBe(false);
  });
});

describe('RAGResultSchema', () => {
  it('should validate result with chunks and stats', () => {
    const result: RAGResult = {
      chunks: [
        {
          chunkId: 'chunk-1',
          resourceId: 'resource-1',
          content: 'Test content',
          contentHash: 'hash123',
          tokenCount: 3,
          filePath: '/test.md',
          embedding: [0.1, 0.2],
          embeddingModel: 'test-model',
          embeddedAt: new Date('2025-01-01'),
        },
      ],
      stats: {
        totalMatches: 5,
        searchDurationMs: 100,
      },
    };

    const parseResult = RAGResultSchema.safeParse(result);

    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.chunks).toHaveLength(1);
      expect(parseResult.data.stats.totalMatches).toBe(5);
    }
  });

  it('should validate result with embedding stats', () => {
    const result: RAGResult = {
      chunks: [],
      stats: {
        totalMatches: 0,
        searchDurationMs: 50,
        embedding: {
          model: 'text-embedding-3-small',
          tokensUsed: 100,
        },
      },
    };

    const parseResult = RAGResultSchema.safeParse(result);

    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.stats.embedding?.model).toBe('text-embedding-3-small');
      expect(parseResult.data.stats.embedding?.tokensUsed).toBe(100);
    }
  });

  it('should reject result with invalid chunk structure', () => {
    const result = {
      chunks: [
        { invalid: 'chunk' }, // Missing required fields
      ],
      stats: {
        totalMatches: 1,
        searchDurationMs: 100,
      },
    };

    const parseResult = RAGResultSchema.safeParse(result);

    expect(parseResult.success).toBe(false);
  });
});
