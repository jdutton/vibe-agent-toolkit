/**
 * Who `indexResources` blames for a failure: one resource, or the batch.
 *
 * `indexResources` wraps each `indexResource` in a per-resource `try` for a real
 * reason: one document that cannot be read or chunked must not abandon a whole
 * indexing batch. A damaged STORE is the other case — every later resource
 * would fail the same read — so it refuses the batch once, carrying what the
 * batch recorded before it.
 *
 * The indexer parses nothing (the registry already did, on the bounded parse
 * route), so the per-resource seam is the text read. Both directions are pinned:
 * a loop that rethrew everything would pass the refusal case and abandon a
 * batch on one unreadable document; a loop that swallowed everything would
 * pass the read-failure cases and report a broken store as broken documents.
 *
 * LanceDB is mocked rather than driven: this suite is about who gets blamed,
 * and a real native table would add a second failure surface (and a native
 * module) to a unit test that has no use for either.
 */

import { type EmbeddingProvider, partialIndexResultOf, type ResourceMetadata } from '@vibe-agent-toolkit/rag';
import { isVatError, RAG_DATABASE_UNREADABLE_CODE, safePath, VatError } from '@vibe-agent-toolkit/utils';
import type * as UtilsFsModule from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

import {
  createBareResource,
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  createTestResource,
  setupLanceDBTestSuite,
} from './test-helpers.js';

/**
 * What the next text read throws, or nothing.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding.
 */
const failures = vi.hoisted(() => ({ queue: [] as Error[] }));

// Only the read seam is replaced, and only when armed: the real read stays live
// via `importOriginal`, so the read-failure cases below fail for the reason a
// real unreadable document fails rather than because a stub said so.
vi.mock('@vibe-agent-toolkit/utils/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsFsModule>();
  const readTextContent = async (filePath: string) => {
    const next = failures.queue.shift();
    return next ? Promise.reject(next) : actual.readTextContent(filePath);
  };
  return { ...actual, readTextContent };
});

// A connection that accepts rows and forgets them. Nothing here asserts on what
// LanceDB stored — only on who the indexing loop blames.
vi.mock('@lancedb/lancedb', () => {
  const table = {
    add: async () => undefined,
    close: () => undefined,
    query: () => ({ where: () => ({ toArray: async () => [] }) }),
  };
  return {
    connect: async () => ({
      listTables: async () => ({ tables: [] }),
      createTable: async () => table,
      openTable: async () => table,
      close: () => undefined,
    }),
  };
});

/** Fixed-width vectors, so nothing in this suite loads an inference runtime. */
const STUB_EMBEDDINGS: EmbeddingProvider = createStubEmbeddingProvider();

const suite = setupLanceDBTestSuite();

beforeEach(async () => {
  failures.queue = [];
  await suite.beforeEach();
  suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, embeddingProvider: STUB_EMBEDDINGS });
});

afterEach(async () => {
  failures.queue = [];
  await suite.afterEach();
});

/**
 * Two resources naming files that were never written.
 *
 * Two, deliberately: a single resource could not tell an aborted batch apart
 * from one recorded error.
 *
 * @returns The absent-file resources
 */
function missingResources(): ResourceMetadata[] {
  return [
    createBareResource('gone-1', safePath.join(suite.tempDir, 'gone-1.md')),
    createBareResource('gone-2', safePath.join(suite.tempDir, 'gone-2.md')),
  ];
}

/**
 * The provider under test, narrowed from the suite's nullable field.
 *
 * @returns The provider created in `beforeEach`
 */
function provider(): LanceDBRAGProvider {
  if (!suite.provider) throw new Error('provider was not created');
  return suite.provider;
}

describe('an ordinary read failure during resource indexing', () => {
  it('records one error per unreadable resource and finishes the batch', async () => {
    const resources = missingResources();

    const result = await provider().indexResources(resources);

    // Two entries, not one: the loop walked past the first failure.
    expect(result.errors).toHaveLength(resources.length);
    expect(result.errors?.map((entry) => entry.resourceId)).toEqual(resources.map((r) => r.id));
    expect(result.resourcesIndexed).toBe(0);
  });

  it('indexes the readable resources in a batch that also has an unreadable one', async () => {
    const readablePath = await createTestMarkdownFile(suite.tempDir, 'ok.md', '# Ok\n\nSome prose to chunk.\n');
    const resources = [
      createBareResource('gone-1', safePath.join(suite.tempDir, 'gone-1.md')),
      createBareResource('ok', readablePath),
    ];

    const result = await provider().indexResources(resources);

    // The baseline the counts above are read against: an unreadable neighbour
    // does not stop a healthy document from being indexed, so a zero elsewhere
    // is never just "this fixture indexes nothing".
    expect(result.errors).toHaveLength(1);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);
  });
});

/**
 * A store refused partway through a batch: what the batch had already recorded
 * travels on the refusal, so the caller still reports the document that failed
 * before it.
 */
/**
 * The bytes the indexer reads are re-hashed and checked against the registry's
 * checksum for them (ADR I2a): the resource's facts — links, headings,
 * frontmatter — describe the bytes the registry admitted, and a file changed
 * between admission and indexing would otherwise be indexed as new text under
 * the old facts. A mismatch refuses that one resource and writes nothing for it.
 */
describe('a file changed between registry admission and indexing', () => {
  it('records an error for that resource, indexes nothing for it, and finishes the batch', async () => {
    const changedPath = await createTestMarkdownFile(suite.tempDir, 'changed.md', '# Before\n\nThe admitted text.\n');
    const steadyPath = await createTestMarkdownFile(suite.tempDir, 'steady.md', '# Steady\n\nUnchanged prose.\n');
    const changed = await createTestResource(changedPath, 'changed');
    const steady = await createTestResource(steadyPath, 'steady');
    await createTestMarkdownFile(suite.tempDir, 'changed.md', '# After\n\nText the registry never saw.\n');
    const embedBatch = vi.spyOn(STUB_EMBEDDINGS, 'embedBatch');

    const result = await provider().indexResources([changed, steady]);

    expect(result.errors).toEqual([
      { resourceId: 'changed', error: expect.stringContaining('changed since') as unknown },
    ]);
    expect(result.resourcesIndexed).toBe(1);
    // One embed call — the steady neighbour's — and none for the changed file.
    expect(embedBatch).toHaveBeenCalledTimes(1);
    embedBatch.mockRestore();
  });
});

describe('a store refusal partway through a batch', () => {
  it('carries the earlier resource failures on the refusal', async () => {
    failures.queue = [new Error('embedder refused'), new VatError(RAG_DATABASE_UNREADABLE_CODE, 'store unreadable')];

    const rejection: unknown = await provider().indexResources(missingResources()).catch((error: unknown) => error);

    expect(isVatError(rejection, RAG_DATABASE_UNREADABLE_CODE)).toBe(true);
    expect(partialIndexResultOf(rejection)?.errors).toEqual([
      { resourceId: 'gone-1', error: expect.stringContaining('embedder refused') as unknown },
    ]);
  });
});
