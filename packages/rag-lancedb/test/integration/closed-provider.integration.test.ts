/**
 * A provider that has been `close()`d must not report work it did not do.
 *
 * `close()` drops the connection and both table handles. `query()` and
 * `getStats()` already reconnect on entry (a workaround for an Arrow buffer
 * lifecycle bug that happens to make them honest after a close as well), and
 * `clear()` calls `close()` and callers go on using the provider — so the
 * provider's contract is that a released connection is reopened on demand, not
 * that a closed provider is dead.
 *
 * The write paths did not keep that contract. With `connection === null` and
 * `table === null`, `indexResources()` ran the whole loop, took neither insert
 * branch, wrote the document record nowhere (`upsertDocumentRecord` returned
 * on the missing connection), and still counted every resource as indexed:
 * `resourcesIndexed: 1, chunksCreated: 1, errors: []` with no table on disk.
 * `deleteResource()` returned without touching anything, and `getDocument()`
 * answered "not found". A success counter with no write behind it is the
 * defect; this pins that every one of those paths reopens the connection and
 * does the work it reports.
 *
 * Real LanceDB: the claim is about what reaches the disk.
 */

import * as lancedb from '@lancedb/lancedb';
import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import {
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  createTestResource,
  setupLanceDBTestSuite,
} from '../test-helpers.js';

const suite = setupLanceDBTestSuite();
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);

/**
 * @returns The table names on disk, read through a connection of this test's own
 */
async function tablesOnDisk(): Promise<string[]> {
  const connection = await lancedb.connect(suite.dbPath);
  const names = await connection.tableNames();
  connection.close();
  return names.sort((x, y) => x.localeCompare(y));
}

/**
 * One resource and a provider over the suite's database with document storage on.
 *
 * @returns The resource `a` and the provider, which is also the suite's for teardown
 */
async function openWithResource(): Promise<{ a: ResourceMetadata; provider: LanceDBRAGProvider }> {
  const path = await createTestMarkdownFile(suite.tempDir, 'a.md', '# A\n\nprose a\n');
  const a = await createTestResource(path, 'a');
  suite.provider = await LanceDBRAGProvider.create({
    dbPath: suite.dbPath,
    storeDocuments: true,
    embeddingProvider: createStubEmbeddingProvider(),
  });
  return { a, provider: suite.provider };
}

describe('LanceDBRAGProvider after close()', () => {
  it('indexResources() writes what it counts', async () => {
    const { a, provider } = await openWithResource();
    await provider.close();

    const result = await provider.indexResources([a]);

    expect(result.errors).toEqual([]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.chunksCreated).toBe(1);
    // The counters above are only true if these are.
    expect(await tablesOnDisk()).toEqual(['rag_chunks', 'rag_documents']);
    expect((await provider.query({ text: 'prose', limit: 5 })).chunks.map((c) => c.resourceId)).toEqual(['a']);
    expect((await provider.getDocument('a'))?.content).toContain('prose a');
  });

  it('deleteResource() and getDocument() reach the tables', async () => {
    const { a, provider } = await openWithResource();
    await provider.indexResources([a]);
    await provider.close();

    // "Not found" after a close was a lie: the row is there.
    expect((await provider.getDocument('a'))?.resourceId).toBe('a');

    await provider.close();
    await provider.deleteResource('a');

    expect(await provider.getDocument('a')).toBeNull();
    expect((await provider.getStats()).totalChunks).toBe(0);
  });
});
