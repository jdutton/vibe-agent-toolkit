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
