/**
 * A query the schema does not declare is refused, not silently widened.
 *
 * The unit suite (`test/unsupported-filters.test.ts`) pins the mechanism —
 * the strict `RAGQuerySchema` refuses unknown keys instead of deleting them. This suite pins the
 * CONSEQUENCE against a real provider over a real index, because that is where the
 * defect was visible and where a schema-only test is structurally blind: nothing that
 * merely calls `safeParse` can see that a filtered query returned the whole corpus.
 *
 * The control case is the point of the file. `returns the whole index when no filter
 * is supplied` establishes that both documents are reachable, so the refusal tests
 * are demonstrably preventing a full-recall result rather than passing because the
 * index was empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTestMarkdownFile, createTestResource, setupLanceDBTestSuite } from '../test-helpers.js';

const PUBLIC_DOC = 'public-doc';
const RESTRICTED_DOC = 'restricted-doc';
const QUERY_TEXT = 'handbook';

/**
 * Reach the runtime guard with a shape the TypeScript surface already rejects.
 *
 * `RAGQuery['filters']` declares neither `tags` nor an arbitrary key, so a typed caller
 * gets a COMPILE error — the better of the two refusals. The runtime guard exists for the
 * JavaScript caller, the JSON payload and the `as` cast, who never meet the type.
 *
 * @param filters - The filter object to smuggle past the compiler
 * @returns The same object, typed as the query's filter parameter
 */
function asUntypedFilters(filters: Record<string, unknown>): { resourceId?: string | string[] } {
  return filters as { resourceId?: string | string[] };
}

const suite = setupLanceDBTestSuite();

/**
 * Index two distinguishable documents so a full-recall result is visible as such.
 *
 * @returns The provider, with both documents indexed
 */
async function indexTwoDocuments(): Promise<LanceDBRAGProvider> {
  const provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

  const publicPath = await createTestMarkdownFile(
    suite.tempDir,
    'public.md',
    '# Public Handbook\n\nOnboarding guidance for every employee.',
  );
  const restrictedPath = await createTestMarkdownFile(
    suite.tempDir,
    'restricted.md',
    '# Restricted Handbook\n\nCompensation bands and severance terms.',
  );

  await provider.indexResources([
    await createTestResource(publicPath, PUBLIC_DOC),
    await createTestResource(restrictedPath, RESTRICTED_DOC),
  ]);

  return provider;
}

describe('unsupported queries are refused rather than widened', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('returns the whole index when no filter is supplied (the control)', async () => {
    suite.provider = await indexTwoDocuments();

    const result = await suite.provider.query({ text: QUERY_TEXT, limit: 10 });

    const ids = result.chunks.map((chunk) => chunk.resourceId);
    expect(ids).toContain(PUBLIC_DOC);
    expect(ids).toContain(RESTRICTED_DOC);
  });

  it('honours a resourceId filter, so refusal is not the only outcome', async () => {
    suite.provider = await indexTwoDocuments();

    const result = await suite.provider.query({
      text: QUERY_TEXT,
      limit: 10,
      filters: { resourceId: PUBLIC_DOC },
    });

    const ids = result.chunks.map((chunk) => chunk.resourceId);
    expect(ids).toContain(PUBLIC_DOC);
    expect(ids).not.toContain(RESTRICTED_DOC);
  });

  it('refuses a query filtered only by dateRange instead of returning both documents', async () => {
    suite.provider = await indexTwoDocuments();

    await expect(
      suite.provider.query({
        text: QUERY_TEXT,
        limit: 10,
        filters: asUntypedFilters({ dateRange: { start: new Date(0), end: new Date(1) } }),
      }),
    ).rejects.toThrow(/dateRange/);
  });

  it('refuses hybridSearch, even disabled, before touching the database', async () => {
    // No indexResources() call: the schema check must not depend on a connection or an
    // embedding, or a caller would get "no data indexed yet" and never learn the field
    // was removed.
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    await expect(
      suite.provider.query({ text: QUERY_TEXT, hybridSearch: { enabled: false } } as never),
    ).rejects.toThrow(/hybridSearch/);
  });

  it('refuses an unknown FILTER before touching the database too', async () => {
    // With nothing indexed, an unguarded query fails with "No data indexed yet" — a message
    // this assertion cannot match — so the test distinguishes the guard from its absence.
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    await expect(
      suite.provider.query({ text: QUERY_TEXT, filters: asUntypedFilters({ tags: ['auth'] }) }),
    ).rejects.toThrow(/tags/);
  });

  it('reports every unknown key present in one error', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    let message = '';
    try {
      await suite.provider.query({
        text: QUERY_TEXT,
        filters: asUntypedFilters({ tags: ['auth'], type: 'guide' }),
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/tags/);
    expect(message).toMatch(/type/);
  });

  it('returns NOTHING for an empty tag list, rather than the whole index', async () => {
    // 🚨 The consequence a unit test states and only a real query can demonstrate. An
    // empty array stringifies to the empty string, so `metadata: { tags: [] }` produced
    // `tags LIKE '%%'` — a condition matching every row. It satisfied the "did any
    // condition survive?" backstop while doing the exact thing the backstop exists to
    // prevent, and the control case above proves both documents are reachable, so a
    // full-recall result here is visible as such rather than hidden by an empty index.
    suite.provider = await indexTwoDocuments();

    const result = await suite.provider.query({
      text: QUERY_TEXT,
      limit: 10,
      filters: { metadata: { tags: [] } },
    });

    expect(result.chunks).toHaveLength(0);
  });

  it.each([
    { label: 'a list holding one empty tag', value: [''] },
    { label: 'a bare empty string', value: '' },
    { label: 'a list holding an empty list', value: [[]] },
  ])('returns NOTHING for $label either, because the mechanism is stringification', async ({ value }) => {
    // 🚨 The case above fixed `[]` by testing `value.length === 0`, but the clause is
    // built from `String(value)` — so every value that stringifies to nothing kept
    // producing `tags LIKE '%%'` and kept returning BOTH documents. Proved by execution:
    // before the fix this assertion read `expected length 0, got 2`, the whole index.
    //
    // None of these needs a cast to arrive. `filters.metadata` is deliberately open, so a
    // JSON payload reaches this path with no type check anywhere in between.
    suite.provider = await indexTwoDocuments();

    const result = await suite.provider.query({
      text: QUERY_TEXT,
      limit: 10,
      filters: { metadata: { tags: value } },
    });

    expect(result.chunks).toHaveLength(0);
  });
});
