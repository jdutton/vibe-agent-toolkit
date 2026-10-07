/**
 * A chunk table LanceDB fails to read is refused once, as the store's failure —
 * and the refusal names WHY, because each cause has a different remedy:
 *
 * - files the OS will not let it read: fix the permissions. Removing the
 *   database (`vat rag clear`) fails on the same files.
 * - a table whose columns are not the ones this provider writes (another
 *   tool's table, or a build that wrote another shape): remove it and index again.
 * - damaged files: remove it and index again.
 *
 * Every cause used to be reported as "its files are damaged".
 *
 * Real LanceDB, on purpose: the failures are LanceDB's own reads.
 */

import { chmodSync, readdirSync, writeFileSync } from 'node:fs';

import * as lancedb from '@lancedb/lancedb';
import { RAG_DATABASE_UNREADABLE_CODE, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createStubEmbeddingProvider, createTestMarkdownFile, createTestResource, setupLanceDBTestSuite } from '../test-helpers.js';

const suite = setupLanceDBTestSuite();
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);

/** A provider over the suite's database, with a runtime-free embedder. */
function openProvider(): Promise<LanceDBRAGProvider> {
  return LanceDBRAGProvider.create({ dbPath: suite.dbPath, embeddingProvider: createStubEmbeddingProvider() });
}

/** {@link openProvider}, kept on the suite so its teardown closes it. */
async function openSuiteProvider(): Promise<LanceDBRAGProvider> {
  const provider = await openProvider();
  suite.provider = provider;
  return provider;
}

/** Index one small document into the suite's database, then close the provider. */
async function indexOneDocument(): Promise<Awaited<ReturnType<typeof createTestResource>>> {
  const resource = await createTestResource(await createTestMarkdownFile(suite.tempDir, 'doc.md', '# Doc\n\nSome prose.\n'), 'doc');
  const provider = await openProvider();
  await provider.indexResources([resource]);
  await provider.close();
  return resource;
}

/** What `run` rejected with, as a message and a code. */
async function failureOf(run: () => Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await run();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: String((error as Error).message) };
  }
  throw new Error('expected a rejection');
}

/** A provider over the suite's (4-dimension) database whose embedding model makes 8, kept on the suite. */
async function openWiderProvider(): Promise<LanceDBRAGProvider> {
  const provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, embeddingProvider: createStubEmbeddingProvider(8) });
  suite.provider = provider;
  return provider;
}

/** A second document, not yet in the index. */
async function doc2(): Promise<Awaited<ReturnType<typeof createTestResource>>> {
  return createTestResource(await createTestMarkdownFile(suite.tempDir, 'doc2.md', '# Doc two\n\nOther prose.\n'), 'doc2');
}

describe('a chunk table LanceDB cannot read', () => {
  it('another tool\'s table is refused for its columns, never called damaged', async () => {
    const connection = await lancedb.connect(suite.dbPath);
    await connection.createTable('rag_chunks', [{ unrelated: 'x', vector: [0, 0, 0, 1] }]);
    connection.close();
    const resource = await createTestResource(await createTestMarkdownFile(suite.tempDir, 'doc.md', '# Doc\n\nSome prose.\n'), 'doc');

    const failure = await failureOf(async () => (await openSuiteProvider()).indexResources([resource]));

    expect(failure.code).toBe(RAG_DATABASE_UNREADABLE_CODE);
    expect(failure.message).toContain('resourceid');
    expect(failure.message).not.toContain('damaged');
  });

  // A table of another vector size reads without error, so nothing but a check of its schema sees it:
  // `index` used to write the new model's vectors into it truncated, and `stats` reported it ok.
  describe('a table another embedding model wrote (its vector size differs)', () => {
    it.each([
      ['index', async (provider: LanceDBRAGProvider) => provider.indexResources([await doc2()])],
      ['query', (provider: LanceDBRAGProvider) => provider.query({ text: 'prose' })],
      ['stats', (provider: LanceDBRAGProvider) => provider.getStats()],
    ] as const)('%s refuses it, naming both sizes', async (_verb, run) => {
      await indexOneDocument();

      const failure = await failureOf(async () => run(await openWiderProvider()));

      expect(failure.code).toBe(RAG_DATABASE_UNREADABLE_CODE);
      expect(failure.message).toContain('its vectors have 4 dimensions and the embedding model makes 8');
      expect(failure.message).not.toContain('damaged');
    });

    it('index writes nothing into it', async () => {
      await indexOneDocument();

      await failureOf(async () => (await openWiderProvider()).indexResources([await doc2()]));

      const connection = await lancedb.connect(suite.dbPath);
      const table = await connection.openTable('rag_chunks');
      const rows = await table.query().select(['resourceid']).toArray();
      const listSize = ((await table.schema()).fields.find((field) => field.name === 'vector')?.type as { listSize?: number }).listSize;
      table.close();
      connection.close();
      expect(rows.map((row: { resourceid: string }) => row.resourceid)).toEqual(['doc']);
      expect(listSize).toBe(4);
    });
  });

  it('damaged data files are still called damaged, with clear as the remedy', async () => {
    await indexOneDocument();
    const data = safePath.join(suite.dbPath, 'rag_chunks.lance', 'data');
    for (const file of readdirSync(data)) writeFileSync(safePath.join(data, file), 'garbage');

    const failure = await failureOf(async () => (await openSuiteProvider()).query({ text: 'prose' }));

    expect(failure.code).toBe(RAG_DATABASE_UNREADABLE_CODE);
    expect(failure.message).toContain('damaged');
    expect(failure.message).toContain('vat rag clear');
  });

  // `data/` refused fails the first READ; the table directory refused fails the OPEN. Both are the
  // permissions refusal, never "damaged", and never `vat rag clear`, which fails on the same files.
  it.skipIf(CANNOT_DENY_READS).each([
    ['the data directory (a read)', ['rag_chunks.lance', 'data']],
    ['the table directory (the open)', ['rag_chunks.lance']],
  ])('%s the OS refuses is named with the errno and a permissions remedy', async (_where, segments) => {
    await indexOneDocument();
    const locked = safePath.join(suite.dbPath, ...segments);
    chmodSync(locked, 0o000);
    let failure: { code: unknown; message: string };
    try {
      failure = await failureOf(async () => (await openSuiteProvider()).getStats());
    } finally {
      chmodSync(locked, 0o755);
    }

    expect(failure.code).toBe(RAG_DATABASE_UNREADABLE_CODE);
    expect(failure.message).toContain(`${locked} (EACCES)`);
    expect(failure.message).toContain('permissions');
    expect(failure.message).not.toContain('damaged');
    expect(failure.message).not.toContain('vat rag clear');
  });
});
