/**
 * A query the provider cannot honour is refused, not silently widened.
 *
 * The unit suite (`test/unsupported-filters.test.ts`) pins the mechanism —
 * `buildWhereClause` throws instead of producing no condition. This suite pins the
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
        filters: { dateRange: { start: new Date(0), end: new Date(1) } },
      }),
    ).rejects.toThrow(/dateRange/);
  });

  it('refuses hybridSearch rather than silently running a pure vector search', async () => {
    suite.provider = await indexTwoDocuments();

    await expect(
      suite.provider.query({
        text: QUERY_TEXT,
        limit: 10,
        hybridSearch: { enabled: true },
      }),
    ).rejects.toThrow(/hybrid search/i);
  });

  it('refuses hybridSearch before touching the database, so an unindexed provider fails the same way', async () => {
    // No indexResources() call: the guard must not depend on a connection or an
    // embedding, or a caller would get "no data indexed yet" and never learn that
    // hybrid search is unimplemented.
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    await expect(
      suite.provider.query({ text: QUERY_TEXT, hybridSearch: { enabled: true } }),
    ).rejects.toThrow(/hybrid search/i);
  });

  it('refuses an unsupported FILTER before touching the database too', async () => {
    // The same property for the other half of the guard. The README claims the refusal
    // needs neither a connection nor an embedding; without this case only the
    // hybridSearch half was pinned, and the filter half was reaching `buildWhereClause`
    // by a route this suite never proved ran first. With nothing indexed, an unguarded
    // query fails with "No data indexed yet" — a message this assertion cannot match —
    // so the test distinguishes the guard from the absence of one.
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    await expect(
      suite.provider.query({ text: QUERY_TEXT, filters: asUntypedFilters({ tags: ['auth'] }) }),
    ).rejects.toThrow(/`filters\.tags`: move it to `filters\.metadata\.tags`/);
  });

  it('reports every unsupported key present in one error', async () => {
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

    // One error naming both, so a query carrying two does not have to be fixed twice.
    expect(message).toMatch(/filters\.tags/);
    expect(message).toMatch(/filters\.type/);
  });

  it('allows hybridSearch when it is explicitly disabled', async () => {
    suite.provider = await indexTwoDocuments();

    const result = await suite.provider.query({
      text: QUERY_TEXT,
      limit: 10,
      hybridSearch: { enabled: false },
    });

    expect(result.chunks.length).toBeGreaterThan(0);
  });
});
