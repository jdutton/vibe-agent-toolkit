/**
 * An interrupted index run must leave a state that the NEXT run repairs.
 *
 * ## The corruption
 *
 * Chunks were written to the vector table INSIDE the per-resource loop. The
 * matching `rag_documents` rows were not: they accumulated in a field and were
 * flushed once, AFTER the loop. So any throw out of the loop — the
 * `ParserUnavailableError` rethrow that `index-resources-parser-load.test.ts`
 * owns, a caller's progress reporter raising, a `SIGINT` on a long index —
 * discarded every pending document record while leaving every chunk already
 * added.
 *
 * That state is not merely wrong, it is TERMINAL. `detectResourceChangeStatus`
 * asks the chunk table one question — "is there a row here whose
 * `resourcecontenthash` equals this content's hash?" — and the chunks that
 * survived answer yes. Every affected resource is therefore SKIPPED on every
 * subsequent run, forever, with chunks in the index and no document row behind
 * them. `getDocument` returns null for a resource the index will never look at
 * again. Nothing errors, nothing warns, and no counter moves.
 *
 * ## What the fix has to be
 *
 * Not "flush more often". The property is that the marker change detection
 * READS must be written LAST, so that any interruption leaves a resource
 * looking unfinished rather than looking finished:
 *
 * 1. the document record is written per resource, before that resource's
 *    chunks. An interruption between the two leaves a document row with no
 *    chunks — and change detection, which counts chunk rows, then reads `new`
 *    and redoes the resource. Self-repairing by construction.
 * 2. change detection additionally refuses to skip a resource whose chunks are
 *    present but whose document row is not. Step 1 stops this state being
 *    CREATED; step 2 is what heals the indexes a shipped build already
 *    corrupted, which step 1 alone cannot reach — those chunks still carry a
 *    matching hash and would still be skipped forever.
 *
 * ## Why this is a unit test
 *
 * LanceDB is replaced by an in-memory fake, and that is the point rather than a
 * concession: the assertions are about WHICH ROWS SURVIVE an interruption, and
 * the fake is a store that can be read directly, with no Arrow buffer lifecycle
 * and no native module. The interruption itself is not mocked at all — a
 * caller's `onProgress` throwing is a real, un-stubbed path out of the loop that
 * needs no seam of any kind.
 */

import type { ResourceMetadata } from '@vibe-agent-toolkit/rag';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

import {
  createBareResource,
  createStubEmbeddingProvider,
  createTestMarkdownFile,
  setupLanceDBTestSuite,
} from './test-helpers.js';

/**
 * The fake's whole storage: table name to rows, readable straight from a test.
 *
 * `vi.hoisted` because the mock factory below is hoisted above every import and
 * would otherwise close over an uninitialised binding.
 */
const store = vi.hoisted(() => ({ tables: new Map<string, Record<string, unknown>[]>() }));

/**
 * A write the fake refuses, so a test can fail one half of a two-table write.
 *
 * Holds the `resourceid` whose DOCUMENT record cannot be stored. Nothing else
 * is injectable: this is the one failure that tells the two possible write
 * orders apart.
 */
const injected = vi.hoisted(() => ({ documentWriteFailsFor: undefined as string | undefined }));

/** The chunk table and the document table, named as the provider names them. */
const CHUNKS_TABLE = 'rag_chunks';
const DOCUMENTS_TABLE = 'rag_documents';

/**
 * An in-memory stand-in for LanceDB that actually remembers what it was given.
 *
 * Only the two predicate shapes the provider emits are understood — `1 = 1` and
 * an equality on `resourceid`. Anything else THROWS rather than quietly matching
 * nothing: a fake that silently returns zero rows for a predicate it does not
 * understand would make every "and then it was skipped" assertion below pass for
 * the wrong reason.
 */
vi.mock('@lancedb/lancedb', () => {
  const RESOURCE_ID_PREDICATE = /^resourceid = '(?<id>.*)'$/su;

  const matches = (row: Record<string, unknown>, predicate: string): boolean => {
    const trimmed = predicate.trim();
    if (trimmed === '1 = 1') return true;
    const id = RESOURCE_ID_PREDICATE.exec(trimmed)?.groups?.['id'];
    if (id === undefined) throw new Error(`fake lancedb: unsupported predicate: ${predicate}`);
    return row['resourceid'] === id.replaceAll("''", "'");
  };

  const rowsOf = (name: string): Record<string, unknown>[] => store.tables.get(name) ?? [];

  const refuseInjected = (name: string, rows: Record<string, unknown>[]): void => {
    const target = injected.documentWriteFailsFor;
    if (name !== 'rag_documents' || target === undefined) return;
    if (rows.some((row) => row['resourceid'] === target)) {
      throw new Error(`fake lancedb: refusing document write for ${target}`);
    }
  };

  const project = (
    row: Record<string, unknown>,
    columns: string[] | undefined,
  ): Record<string, unknown> =>
    columns ? Object.fromEntries(columns.map((c) => [c, row[c]])) : row;

  const selectRows = (
    name: string,
    predicate: string,
    cap: number,
    columns: string[] | undefined,
  ): Record<string, unknown>[] =>
    rowsOf(name)
      .filter((row) => matches(row, predicate))
      .slice(0, cap)
      .map((row) => project(row, columns));

  const makeTable = (name: string) => ({
    add: async (rows: Record<string, unknown>[]) => {
      refuseInjected(name, rows);
      store.tables.set(name, [...rowsOf(name), ...rows]);
    },
    delete: async (predicate: string) => {
      store.tables.set(name, rowsOf(name).filter((row) => !matches(row, predicate)));
    },
    countRows: async () => rowsOf(name).length,
    close: () => undefined,
    query: () => {
      let columns: string[] | undefined;
      let predicate = '1 = 1';
      let cap = Number.POSITIVE_INFINITY;
      const builder = {
        select: (cols: string[]) => {
          columns = cols;
          return builder;
        },
        where: (p: string) => {
          predicate = p;
          return builder;
        },
        limit: (n: number) => {
          cap = n;
          return builder;
        },
        toArray: async () => selectRows(name, predicate, cap, columns),
      };
      return builder;
    },
  });

  return {
    connect: async () => ({
      tableNames: async () => [...store.tables.keys()],
      createTable: async (
        name: string,
        rows: Record<string, unknown>[],
        options?: { mode?: string },
      ) => {
        refuseInjected(name, rows);
        if (options?.mode === 'overwrite' || !store.tables.has(name)) store.tables.set(name, []);
        store.tables.set(name, [...rowsOf(name), ...rows]);
        return makeTable(name);
      },
      openTable: async (name: string) => {
        if (!store.tables.has(name)) throw new Error(`fake lancedb: no such table: ${name}`);
        return makeTable(name);
      },
      close: () => undefined,
    }),
  };
});

const suite = setupLanceDBTestSuite();

/** Four is the smallest corpus that has a "before", a "during" and an "after". */
const CORPUS_SIZE = 4;

/** The resource whose `onProgress` call raises, 1-based. Two are done by then. */
const INTERRUPT_AFTER = 2;

beforeEach(async () => {
  store.tables.clear();
  injected.documentWriteFailsFor = undefined;
  await suite.beforeEach();
});

afterEach(async () => {
  await suite.afterEach();
  store.tables.clear();
  injected.documentWriteFailsFor = undefined;
});

/**
 * A provider over the shared temp db path, with document storage on.
 *
 * A FRESH provider per run, deliberately: the discarded records lived in
 * instance state, so reusing one object would let the second run see them and
 * prove nothing about what reached the database.
 *
 * @returns A newly created provider
 */
async function newRun(): Promise<LanceDBRAGProvider> {
  return LanceDBRAGProvider.create({
    dbPath: suite.dbPath,
    embeddingProvider: createStubEmbeddingProvider(),
    storeDocuments: true,
  });
}

/**
 * Write `CORPUS_SIZE` small markdown files and describe them to the indexer.
 *
 * @returns Metadata for every file, in indexing order
 */
async function writeCorpus(): Promise<ResourceMetadata[]> {
  const resources: ResourceMetadata[] = [];
  for (let n = 1; n <= CORPUS_SIZE; n++) {
    const name = `doc-${n}.md`;
    await createTestMarkdownFile(
      suite.tempDir,
      name,
      `# Document ${n}\n\nProse belonging to document number ${n}.\n`,
    );
    resources.push(createBareResource(`doc-${n}`, safePath.join(suite.tempDir, name)));
  }
  return resources;
}

/**
 * Resource ids that have at least one chunk row.
 *
 * @returns The set of resource ids present in the chunk table
 */
function chunkedResourceIds(): Set<string> {
  return new Set((store.tables.get(CHUNKS_TABLE) ?? []).map((row) => String(row['resourceid'])));
}

/**
 * Resource ids that have a document row.
 *
 * @returns The set of resource ids present in the documents table
 */
function documentedResourceIds(): Set<string> {
  return new Set((store.tables.get(DOCUMENTS_TABLE) ?? []).map((row) => String(row['resourceid'])));
}

/**
 * A progress reporter that raises once the run is genuinely underway.
 *
 * `onProgress` fires after each resource is written, so raising on the second
 * call means two resources reached the database and two never started — the
 * shape every real interruption has.
 *
 * @param boom - The error the reporter raises
 * @returns The reporter to hand to `indexResources`
 */
function interruptAfterTwo(boom: Error): () => void {
  let calls = 0;
  return () => {
    calls++;
    if (calls === INTERRUPT_AFTER) throw boom;
  };
}

describe('an index run interrupted after some resources were written', () => {
  it('leaves every resource with BOTH its chunks and its document row once re-run', async () => {
    const resources = await writeCorpus();
    const boom = new Error('progress reporter exploded');

    const interrupted = await newRun();
    await expect(
      interrupted.indexResources(resources, interruptAfterTwo(boom)),
    ).rejects.toBe(boom);
    await interrupted.close();

    // The vacuity control. If the interruption had landed before any write, or
    // after all of them, the repair assertion below would be trivially true.
    // Two resources in and two to go is the state that actually bites.
    expect(chunkedResourceIds()).toEqual(new Set(['doc-1', 'doc-2']));

    // Work completed is work KEPT. Batching the document records to the end of
    // the loop meant an interruption discarded every record the run had built —
    // two here, and 9,999 of them on a corpus that size. Written per resource,
    // the finished resources are finished.
    expect(documentedResourceIds()).toEqual(new Set(['doc-1', 'doc-2']));

    const repaired = await newRun();
    const result = await repaired.indexResources(resources);
    await repaired.close();

    const expected = new Set(resources.map((r) => r.id));

    // The property. Under the defect, doc-1 and doc-2 came back with chunks
    // whose hash still matched, were skipped, and never got a document row —
    // so `documentedResourceIds()` held only doc-3 and doc-4, permanently.
    expect(chunkedResourceIds()).toEqual(expected);
    expect(documentedResourceIds()).toEqual(expected);

    // And the run reported no failure, so a caller had nothing to act on.
    expect(result.errors).toEqual([]);
  });

  it('reports each resource exactly once across the two runs, without duplicating chunks', async () => {
    const resources = await writeCorpus();

    const interrupted = await newRun();
    await expect(
      interrupted.indexResources(resources, interruptAfterTwo(new Error('stop'))),
    ).rejects.toThrow('stop');
    await interrupted.close();

    const chunksAfterInterruption = (store.tables.get(CHUNKS_TABLE) ?? []).length;

    const repaired = await newRun();
    await repaired.indexResources(resources);
    await repaired.close();

    // One document row per resource, not one per attempt: the repair must
    // replace a resource's row rather than accumulate a second one.
    expect(store.tables.get(DOCUMENTS_TABLE)).toHaveLength(CORPUS_SIZE);

    // Chunk rows only grew by the resources the first run never reached, or by
    // a redo that deleted its predecessor's rows first — never by a silent
    // double-insert of the two that had already been written.
    const perResource = chunksAfterInterruption / INTERRUPT_AFTER;
    expect(store.tables.get(CHUNKS_TABLE)).toHaveLength(perResource * CORPUS_SIZE);
  });
});

/**
 * The invariant that makes the write ORDER matter, stated as a property.
 *
 * At no point may the index hold chunks for a resource that has no document
 * record — that pairing is precisely the corruption, and change detection
 * cannot see past it. Writing the document record first makes the invariant
 * hold by construction: whichever of the two writes fails, the resource is left
 * looking unfinished, and the next run finishes it.
 *
 * Failing the DOCUMENT write is the one injection that tells the two orders
 * apart. Fail the chunk write instead and both orders look identical, because
 * under either one the failure lands before anything a reader can see.
 */
describe('a resource whose document record cannot be stored', () => {
  it('never leaves its chunks behind in the index', async () => {
    const resources = await writeCorpus();
    // doc-2, not doc-1: the very first record CREATES the table, and this test
    // is about the steady-state write, not about table creation.
    injected.documentWriteFailsFor = 'doc-2';

    const run = await newRun();
    const result = await run.indexResources(resources);
    await run.close();

    // The failure is reported — this is an ordinary per-resource error, not a
    // batch-abandoning one — so a caller has something to act on.
    expect(result.errors?.map((entry) => entry.resourceId)).toEqual(['doc-2']);

    // The invariant. Reverse the two writes and doc-2's chunks are sitting in
    // the index with no document row behind them.
    expect([...chunkedResourceIds()].every((id) => documentedResourceIds().has(id))).toBe(true);
    expect(chunkedResourceIds()).not.toContain('doc-2');

    // And the resource is not lost: with its chunks absent, the next run reads
    // it as new and indexes it.
    injected.documentWriteFailsFor = undefined;
    const retry = await newRun();
    await retry.indexResources(resources);
    await retry.close();

    const expected = new Set(resources.map((r) => r.id));
    expect(chunkedResourceIds()).toEqual(expected);
    expect(documentedResourceIds()).toEqual(expected);
  });
});

/**
 * The half that step 1 alone cannot reach.
 *
 * Every index a shipped build already half-wrote is in exactly this state:
 * chunks present, document row absent, content unchanged. Writing the document
 * record earlier stops it happening again and does nothing whatsoever for the
 * databases already on disk — their chunks still carry a matching hash, so
 * change detection still skips them, forever. Only a detector that notices the
 * missing row heals them.
 */
describe('an index already corrupted by an earlier build', () => {
  it('re-indexes a resource whose chunks exist but whose document row does not', async () => {
    const resources = await writeCorpus();

    const first = await newRun();
    await first.indexResources(resources);
    await first.close();

    expect(documentedResourceIds()).toEqual(new Set(resources.map((r) => r.id)));

    // Reproduce the on-disk damage directly rather than by re-deriving it: drop
    // one document row and leave its chunks exactly as they are. This is what a
    // SIGINT during the old build's post-loop flush left behind.
    store.tables.set(
      DOCUMENTS_TABLE,
      (store.tables.get(DOCUMENTS_TABLE) ?? []).filter((row) => row['resourceid'] !== 'doc-2'),
    );
    expect(documentedResourceIds()).not.toContain('doc-2');

    const healing = await newRun();
    const result = await healing.indexResources(resources);
    await healing.close();

    expect(documentedResourceIds()).toEqual(new Set(resources.map((r) => r.id)));

    // And only the damaged one was redone: an index that re-embedded its whole
    // corpus on every run would also satisfy the assertion above, at a cost no
    // adopter would accept.
    expect(result.resourcesSkipped).toBe(CORPUS_SIZE - 1);
  });

  it('still skips an unchanged resource whose document row is present', async () => {
    const resources = await writeCorpus();

    const first = await newRun();
    await first.indexResources(resources);
    await first.close();

    const second = await newRun();
    const result = await second.indexResources(resources);
    await second.close();

    // The negative control for the detector above. Without it, a change
    // detector that simply stopped trusting `skip` would pass every assertion
    // in this file while re-embedding the entire corpus on every single run.
    expect(result.resourcesSkipped).toBe(CORPUS_SIZE);
    expect(result.resourcesIndexed).toBe(0);
  });
});
