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

/**
 * Put a query through the transformation a network hop performs on it.
 *
 * ⚠️ Serialise then deserialise, deliberately — NOT `structuredClone`, which preserves a
 * `Date` and would make every assertion below vacuous. The whole point is that JSON has no
 * date type, so the bound arrives as the ISO-8601 string the published JSON Schema declares.
 *
 * @param query - The query as a caller would build it in TypeScript
 * @returns The same query as it arrives at the far end, with every Date now a string
 */
function acrossTheWire(query: unknown): unknown {
  const payload = JSON.stringify(query);
  return JSON.parse(payload);
}

/**
 * The two halves of one exported contract must accept the same values.
 *
 * 🚨 `dateRange` was where they disagreed, and the disagreement fell on the ONLY
 * representation that can cross a wire. `zod-to-json-schema` emits
 * `{"type":"string","format":"date-time"}` for a `z.date()`, so the published
 * `RAGQueryJsonSchema` tells every adopter that an ISO-8601 string is the correct value —
 * and JSON has no other way to carry a date. The Zod half was a bare `z.date()`, which
 * rejects a string with `invalid_type`. So a payload that validated against VAT's own
 * published schema failed VAT's own `safeParse`: the adopter who did exactly as told was
 * the one who got the error.
 *
 * 🔑 These tests pin the PROPERTY, not the ISO example: a query that has been through
 * `JSON.stringify` / `JSON.parse` — which is what "crossed a wire" MEANS, and what turns a
 * `Date` into the string the JSON Schema declares — must parse. A test that merely fed a
 * hand-typed ISO literal would pass a fix that happened to accept that one literal while
 * still disagreeing with what the schema publishes.
 */
describe('RAGQuerySchema agrees with the JSON Schema it publishes about dates', () => {
  const START = new Date('2026-01-01T00:00:00.000Z');
  const END = new Date('2026-02-01T00:00:00.000Z');

  it('declares dateRange bounds as date-time strings in the schema it publishes', () => {
    // Read from the emitted schema rather than asserted from memory: this is the half of
    // the contract the adopter validates against, and it is what makes the case below the
    // representation under test rather than an arbitrary one.
    const emitted = RAGQueryJsonSchema as {
      definitions: {
        RAGQuery: {
          properties: {
            filters: {
              properties: {
                dateRange: { properties: { start: { type: string; format: string } } };
              };
            };
          };
        };
      };
    };
    const start = emitted.definitions.RAGQuery.properties.filters.properties.dateRange.properties.start;

    expect(start.type).toBe('string');
    expect(start.format).toBe('date-time');
  });

  it('parses a dateRange that has crossed a wire', () => {
    const wire = acrossTheWire({ text: TEST_SEARCH_TERM, filters: { dateRange: { start: START, end: END } } });

    // The bounds really are strings by now — otherwise this test would prove nothing.
    expect(typeof (wire as { filters: { dateRange: { start: unknown } } }).filters.dateRange.start).toBe('string');
    expect(RAGQuerySchema.safeParse(wire).success).toBe(true);
  });

  it('hands the consumer a Date whichever way the bound arrived', () => {
    // The two entry points must converge on one type, or every reader of a parsed query
    // needs a `typeof` check that the schema exists to make unnecessary.
    const fromWire = RAGQuerySchema.safeParse(
      acrossTheWire({ text: TEST_SEARCH_TERM, filters: { dateRange: { start: START, end: END } } }),
    );
    const fromTypeScript = RAGQuerySchema.safeParse({
      text: TEST_SEARCH_TERM,
      filters: { dateRange: { start: START, end: END } },
    });

    expect(fromWire.success).toBe(true);
    expect(fromTypeScript.success).toBe(true);
    const wireStart = fromWire.success ? fromWire.data.filters?.dateRange?.start : undefined;
    const tsStart = fromTypeScript.success ? fromTypeScript.data.filters?.dateRange?.start : undefined;
    expect(wireStart).toBeInstanceOf(Date);
    expect(wireStart?.getTime()).toBe(START.getTime());
    expect(tsStart).toBeInstanceOf(Date);
  });

  it('still refuses a string that is not a date at all', () => {
    // The neighbour case: accepting the published representation must not degrade the
    // field into "any string".
    const result = RAGQuerySchema.safeParse({
      text: TEST_SEARCH_TERM,
      filters: { dateRange: { start: 'last Tuesday', end: END.toISOString() } },
    });

    expect(result.success).toBe(false);
  });

  // 🚨 FINDING 3 — `dateRange` is the fourth `.strict()` in this schema and was the only
  // one no assertion pinned: deleting it left the whole suite green, while deleting any of
  // the other three reds a test. An unpinned guard is a guard that comes back off in the
  // next edit, and this one guards the same widening as its three neighbours — a Zod object
  // DELETES an unknown key, so `{ start, end, inclusive: true }` would parse into a range
  // silently missing the caller's third condition.
  it('refuses an unknown key inside dateRange, as every other object here does', () => {
    const result = RAGQuerySchema.safeParse({
      text: TEST_SEARCH_TERM,
      filters: { dateRange: { start: START.toISOString(), end: END.toISOString(), inclusive: true } },
    });

    expect(result.success).toBe(false);
  });

  it('names the offending key inside dateRange', () => {
    const result = RAGQuerySchema.safeParse({
      text: TEST_SEARCH_TERM,
      filters: { dateRange: { start: START.toISOString(), end: END.toISOString(), inclusive: true } },
    });
    const issues = result.success ? [] : result.error.issues;

    expect(JSON.stringify(issues)).toMatch(/inclusive/);
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
