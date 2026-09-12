/**
 * A resource that yields ZERO chunks is a normal outcome, in every position and
 * on every run.
 *
 * A frontmatter-only `.md` — a stub `index.md`, a metadata-only page — chunks
 * to nothing, and that is the honest reading: there is no prose to retrieve.
 * Two things went wrong at the index boundary with that honest zero:
 *
 * 1. When such a resource was the FIRST one into a fresh database, the chunk
 *    table did not exist yet and was created from its (empty) row list. LanceDB
 *    refuses `createTable(name, [])` — "At least one record or a schema needs
 *    to be provided" — so the resource landed in `errors`, `vat rag index`
 *    reported `status: partial` and exited 1, and the SAME resource succeeded
 *    on the next run because a neighbour had created the table in the
 *    meantime. An outcome that depends on enumeration order and on which run
 *    this is, over content that is entirely legitimate.
 * 2. Change detection reads chunk rows, and a zero-chunk resource leaves none,
 *    so it read as `new` on every run — re-parsed, re-chunked, counted in
 *    `resourcesIndexed` forever, and (with document storage on) its document
 *    row rewritten each time.
 *
 * Real LanceDB, on purpose: (1) is LanceDB's own refusal, and a fake that
 * accepted an empty `createTable` would pass the test the defect fails.
 */

import type { IndexResult, ResourceMetadata } from '@vibe-agent-toolkit/rag';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import {
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  createTestResource,
  setupLanceDBTestSuite,
} from '../test-helpers.js';

const FRONTMATTER_ONLY = '---\ntitle: Only Frontmatter\n---\n';
const REAL_PROSE = '# Real\n\nSome prose worth retrieving.\n';

const suite = setupLanceDBTestSuite();
beforeEach(suite.beforeEach);
afterEach(suite.afterEach);

/**
 * A provider over the suite's database, with a runtime-free embedder.
 *
 * @param storeDocuments - Whether to keep a `rag_documents` row per resource
 * @returns A provider ready to index
 */
async function openProvider(storeDocuments: boolean): Promise<LanceDBRAGProvider> {
  return LanceDBRAGProvider.create({
    dbPath: suite.dbPath,
    embeddingProvider: createStubEmbeddingProvider(),
    storeDocuments,
  });
}

/**
 * Write one frontmatter-only file and one real document, parsed for real.
 *
 * @returns Both resources, the frontmatter-only one first
 */
async function writeCorpus(): Promise<{ empty: ResourceMetadata; real: ResourceMetadata }> {
  const emptyPath = await createTestMarkdownFile(suite.tempDir, 'stub.md', FRONTMATTER_ONLY);
  const realPath = await createTestMarkdownFile(suite.tempDir, 'real.md', REAL_PROSE);
  return {
    empty: await createTestResource(emptyPath, 'stub'),
    real: await createTestResource(realPath, 'real'),
  };
}

/**
 * The counters a run reports, minus the timing.
 *
 * @param result - A completed index run
 * @returns Every field an assertion here cares about
 */
function countersOf(result: IndexResult): Omit<IndexResult, 'durationMs'> {
  const counters: Partial<IndexResult> = { ...result };
  delete counters.durationMs;
  return counters as Omit<IndexResult, 'durationMs'>;
}

describe.each([false, true])('zero-chunk resource (storeDocuments: %s)', (storeDocuments) => {
  it('does not fail the run when it is the FIRST resource into a fresh index', async () => {
    const { empty, real } = await writeCorpus();
    suite.provider = await openProvider(storeDocuments);

    const result = await suite.provider.indexResources([empty, real]);

    expect(countersOf(result)).toEqual({
      resourcesIndexed: 1,
      resourcesSkipped: 0,
      resourcesUpdated: 0,
      resourcesEmpty: 1,
      chunksCreated: 1,
      chunksDeleted: 0,
      errors: [],
    });

    // The real document is retrievable: the deferred table creation wrote it.
    const found = await suite.provider.query({ text: 'prose', limit: 5 });
    expect(found.chunks.map((c) => c.resourceId)).toEqual(['real']);
  });

  it('reports the same counters whichever order the resources arrive in', async () => {
    const { empty, real } = await writeCorpus();

    const emptyFirst = await openProvider(storeDocuments);
    const first = await emptyFirst.indexResources([empty, real]);
    await emptyFirst.clear();

    suite.provider = await openProvider(storeDocuments);
    const second = await suite.provider.indexResources([real, empty]);

    expect(countersOf(second)).toEqual(countersOf(first));
    expect(first.errors).toEqual([]);
  });

  it('is not re-indexed on the next run', async () => {
    const { empty, real } = await writeCorpus();
    suite.provider = await openProvider(storeDocuments);
    await suite.provider.indexResources([empty, real]);

    const rerun = await suite.provider.indexResources([empty, real]);

    expect(countersOf(rerun)).toEqual({
      resourcesIndexed: 0,
      resourcesSkipped: 1,
      resourcesUpdated: 0,
      resourcesEmpty: 1,
      chunksCreated: 0,
      chunksDeleted: 0,
      errors: [],
    });
  });

  it('indexes a corpus made ONLY of zero-chunk resources without error', async () => {
    const { empty } = await writeCorpus();
    suite.provider = await openProvider(storeDocuments);

    const result = await suite.provider.indexResources([empty]);

    expect(result.errors).toEqual([]);
    expect(result.resourcesEmpty).toBe(1);
    expect(result.resourcesIndexed).toBe(0);

    // Nothing was written, and the statistics say so rather than failing.
    const stats = await suite.provider.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalResources).toBe(0);
  });

  it('removes the stale chunks of a resource whose content shrank to frontmatter only', async () => {
    const { real } = await writeCorpus();
    suite.provider = await openProvider(storeDocuments);
    await suite.provider.indexResources([real]);

    await createTestMarkdownFile(suite.tempDir, 'real.md', FRONTMATTER_ONLY);
    const shrunk = await createTestResource(real.filePath, 'real');

    const result = await suite.provider.indexResources([shrunk]);

    expect(countersOf(result)).toEqual({
      resourcesIndexed: 0,
      resourcesSkipped: 0,
      resourcesUpdated: 1,
      resourcesEmpty: 1,
      chunksCreated: 0,
      chunksDeleted: 1,
      errors: [],
    });
    expect((await suite.provider.getStats()).totalChunks).toBe(0);
  });
});

describe('zero-chunk resource with document storage on', () => {
  it('keeps a document record that says zero chunks, and does not rewrite it on the next run', async () => {
    const { empty, real } = await writeCorpus();
    suite.provider = await openProvider(true);

    await suite.provider.indexResources([empty, real]);
    const afterFirst = await suite.provider.getDocument('stub');
    expect(afterFirst).not.toBeNull();
    expect(afterFirst?.totalChunks).toBe(0);
    expect(afterFirst?.content).toBe(FRONTMATTER_ONLY);

    // A record of "seen at this hash": the next run must leave it untouched,
    // and `indexedAt` is the field a rewrite cannot help but move. The wait is
    // what makes a rewrite VISIBLE — two runs inside one millisecond would
    // stamp the same `Date.now()` and make this assertion pass either way.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await suite.provider.indexResources([empty, real]);
    const afterSecond = await suite.provider.getDocument('stub');
    expect(afterSecond?.indexedAt.getTime()).toBe(afterFirst?.indexedAt.getTime());
  });

  it('rewrites the document record when the frontmatter itself changes', async () => {
    const { empty } = await writeCorpus();
    suite.provider = await openProvider(true);
    await suite.provider.indexResources([empty]);

    const changed = '---\ntitle: Still Only Frontmatter\n---\n';
    await createTestMarkdownFile(suite.tempDir, 'stub.md', changed);
    const result = await suite.provider.indexResources([await createTestResource(empty.filePath, 'stub')]);

    expect(result.errors).toEqual([]);
    expect(result.resourcesEmpty).toBe(1);
    expect((await suite.provider.getDocument('stub'))?.content).toBe(changed);
  });
});
