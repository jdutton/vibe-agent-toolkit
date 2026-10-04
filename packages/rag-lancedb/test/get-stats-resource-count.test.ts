/**
 * `getStats()` counts distinct resources by reading ONE column.
 *
 * It used to read every row of the chunk table in full — text, embedding vector
 * and metadata — and round-trip the lot through JSON, only to count distinct
 * `resourceid`s. The fake below stands in for LanceDB and refuses any chunk read
 * that does not project to `resourceid`, so the full-row scan fails here rather
 * than merely costing time on a large index.
 */

import { describe, expect, it, vi } from 'vitest';

import { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

import { createStubEmbeddingProvider } from './test-helpers.js';

/** Three chunks over two resources. `vi.hoisted` because the mock factory is hoisted above it. */
const rows = vi.hoisted(() => [
  { resourceid: 'a', text: 'one', vector: [0, 0, 0, 1] },
  { resourceid: 'a', text: 'two', vector: [0, 0, 0, 1] },
  { resourceid: 'b', text: 'three', vector: [0, 0, 0, 1] },
]);

vi.mock('@lancedb/lancedb', () => {
  const table = {
    countRows: async () => rows.length,
    close: () => undefined,
    query: () => {
      let columns: string[] | undefined;
      const builder = {
        select: (cols: string[]) => {
          columns = cols;
          return builder;
        },
        where: () => builder,
        toArray: async () => {
          if (columns?.length !== 1 || columns[0] !== 'resourceid') {
            throw new Error(`fake lancedb: getStats read columns ${JSON.stringify(columns ?? 'ALL')}, not just resourceid`);
          }
          return rows.map((row) => ({ resourceid: row.resourceid }));
        },
      };
      return builder;
    },
  };
  return {
    connect: async () => ({
      listTables: async () => ({ tables: ['rag_chunks'] }),
      openTable: async () => table,
      close: () => undefined,
    }),
  };
});

describe('getStats', () => {
  it('counts distinct resources from the resourceid column alone', async () => {
    const provider = await LanceDBRAGProvider.create({ dbPath: '/nonexistent/vat-get-stats-db', embeddingProvider: createStubEmbeddingProvider() });

    const stats = await provider.getStats();

    expect(stats).toMatchObject({ totalChunks: 3, totalResources: 2 });
  });
});
