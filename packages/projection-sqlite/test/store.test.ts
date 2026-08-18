/**
 * The store's semantics, against a real database in a temporary directory.
 *
 * The strongest assertion available is that a row written and read back still
 * **validates against its own Zod schema** — that catches a `Date` returning as
 * a string, a boolean returning as a number and a JSON column returning as
 * text, none of which throw and all of which pass a shallow `toEqual` against a
 * fixture built the same wrong way.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import {
  PROJECTION_TABLES,
  type ExtentKey,
  type ProjectionStore,
  type ProjectionTableName,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteProjectionStore } from '../src/store.js';

import { FIRST_BLOB, SECOND_BLOB, sampleBlobRows, sampleExtentRows } from './fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };

let directory: string;
let store: ProjectionStore;

beforeEach(() => {
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-sqlite-'));
  store = openSqliteProjectionStore({ directory });
});

afterEach(async () => {
  await store.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Assert every row of every named table still satisfies its row schema.
 *
 * @param bundle - What the store returned
 * @param names - The tables to check
 */
function expectSchemaValid(bundle: Record<string, readonly unknown[]>, names: readonly ProjectionTableName[]): void {
  for (const name of names) {
    const spec = PROJECTION_TABLES[name];
    for (const row of bundle[name] ?? []) {
      const parsed = spec.schema.safeParse(row);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  }
}

describe('blob facts', () => {
  it('round-trips every column kind back into schema-valid rows', async () => {
    const written = sampleBlobRows();
    await store.writeBlobFacts(written);

    const read = await store.readBlobFacts([FIRST_BLOB]) as unknown as Record<string, readonly unknown[]>;
    expectSchemaValid(read, ['blobs', 'blobReferences', 'blobSections', 'blobConditions']);
    expect(read).toEqual(written);
  });

  it('returns nothing for a key it has never seen — a miss, not an error', async () => {
    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.blobs).toEqual([]);
    expect(read.blobReferences).toEqual([]);
  });

  it('reports presence through the blobs table, not through a child table', async () => {
    // A blob with no references legitimately has zero `blobReferences` rows;
    // a caller inferring "not cached" from that would re-parse it forever.
    const bare = sampleBlobRows();
    await store.writeBlobFacts({ ...bare, blobReferences: [], blobSections: [], blobConditions: [] });

    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.blobs).toHaveLength(1);
    expect(read.blobReferences).toEqual([]);
  });

  it('is idempotent — writing the same facts twice does not duplicate a row', async () => {
    await store.writeBlobFacts(sampleBlobRows());
    await store.writeBlobFacts(sampleBlobRows());

    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.blobs).toHaveLength(1);
    // The interesting one: `blob_conditions` keys on a nullable `line`, so a
    // conflict clause would NOT have deduplicated this row.
    expect(read.blobConditions).toHaveLength(1);
  });

  it('keeps one blob\'s facts when another is rewritten', async () => {
    await store.writeBlobFacts(sampleBlobRows(FIRST_BLOB));
    await store.writeBlobFacts(sampleBlobRows(SECOND_BLOB));
    await store.writeBlobFacts(sampleBlobRows(SECOND_BLOB));

    const read = await store.readBlobFacts([FIRST_BLOB, SECOND_BLOB]);
    expect(read.blobs).toHaveLength(2);
  });

  it('returns only the keys asked for', async () => {
    await store.writeBlobFacts(sampleBlobRows(FIRST_BLOB));
    await store.writeBlobFacts(sampleBlobRows(SECOND_BLOB));

    const read = await store.readBlobFacts([SECOND_BLOB]);
    expect(read.blobs.map((row) => row.contentKey)).toEqual([SECOND_BLOB]);
  });

  it('accepts an empty key list without emitting an IN () that cannot parse', async () => {
    const read = await store.readBlobFacts([]);
    expect(read.blobs).toEqual([]);
  });

  it('accepts an empty bundle', async () => {
    const empty = sampleBlobRows();
    await expect(store.writeBlobFacts({
      ...empty, blobs: [], blobReferences: [], blobSections: [], blobConditions: [],
    })).resolves.toBeUndefined();
  });

  it('refuses facts for a blob the bundle does not carry', async () => {
    const orphaned = sampleBlobRows(FIRST_BLOB);
    await expect(store.writeBlobFacts({ ...orphaned, blobs: [] }))
      .rejects.toThrow(/blobs table does not name/u);
  });
});

describe('extents', () => {
  it('round-trips every column kind back into schema-valid rows', async () => {
    const written = sampleExtentRows(KEY.rootId);
    await store.writeExtent(KEY, written);

    const read = await store.readExtent(KEY) as unknown as Record<string, readonly unknown[]>;
    expect(read).toBeDefined();
    expectSchemaValid(read, [
      'roots', 'resources', 'resourceRealizations', 'resourceExtents',
      'resourceTags', 'realizationConditions', 'resolutionContexts', 'zoneProvenance',
    ]);
    expect(read).toEqual(written);
  });

  it('restores an mtime as a Date, not as the string it was stored as', async () => {
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));

    const read = await store.readExtent(KEY);
    const [realization] = read?.resourceRealizations ?? [];
    expect(realization?.mtime).toBeInstanceOf(Date);
    expect(realization?.mtime?.toISOString()).toBe('2026-08-18T12:34:56.789Z');
  });

  it('reports a tree it has never seen as undefined', async () => {
    expect(await store.readExtent(KEY)).toBeUndefined();
  });

  it('distinguishes a written-but-empty extent from an unwritten one', async () => {
    // Both produce zero rows from every table, so only the manifest row tells
    // them apart — a hit that holds nothing versus a miss.
    const empty = sampleExtentRows(KEY.rootId);
    await store.writeExtent(KEY, {
      ...empty,
      roots: [], resources: [], resourceRealizations: [], resourceExtents: [],
      resourceTags: [], realizationConditions: [], resolutionContexts: [], zoneProvenance: [],
    });

    const read = await store.readExtent(KEY);
    expect(read).toBeDefined();
    expect(read?.roots).toEqual([]);
    expect(await store.readExtent({ ...KEY, treeHash: 'tree-bbb' })).toBeUndefined();
  });

  it('keeps two trees of one root apart', async () => {
    const other: ExtentKey = { rootId: KEY.rootId, treeHash: 'tree-bbb' };
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.writeExtent(other, {
      ...sampleExtentRows(KEY.rootId),
      resources: [{
        resourceId: 'res-2', kind: 'file', origin: 'git', observed: true, fromEnumeration: true, vatId: null,
      }],
    });

    expect((await store.readExtent(KEY))?.resources.map((row) => row.resourceId)).toEqual(['res-1']);
    expect((await store.readExtent(other))?.resources.map((row) => row.resourceId)).toEqual(['res-2']);
  });

  it('keeps two roots at the same tree hash apart', async () => {
    // Two projects sharing a cache namespace is exactly the case the root half
    // of the key exists for.
    const other: ExtentKey = { rootId: 'root-2', treeHash: KEY.treeHash };
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.writeExtent(other, sampleExtentRows('root-2'));

    expect((await store.readExtent(KEY))?.roots.map((row) => row.id)).toEqual(['root-1']);
    expect((await store.readExtent(other))?.roots.map((row) => row.id)).toEqual(['root-2']);
  });

  it('replaces a key rather than appending to it', async () => {
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));

    expect((await store.readExtent(KEY))?.resources).toHaveLength(1);
    expect((await store.readExtent(KEY))?.resourceTags).toHaveLength(1);
  });
});

describe('lifetime', () => {
  it('reopens an existing store and still reads what was written', async () => {
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.close();

    store = openSqliteProjectionStore({ directory });
    expect((await store.readExtent(KEY))?.resources).toHaveLength(1);
  });

  it('rejects use after close rather than silently reopening', async () => {
    await store.close();
    await expect(store.readExtent(KEY)).rejects.toThrow(/closed/u);
    await expect(store.writeBlobFacts(sampleBlobRows())).rejects.toThrow(/closed/u);
  });

  it('closes twice without complaint', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
