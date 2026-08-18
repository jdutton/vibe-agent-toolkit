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
  type ExtentScopedRows,
  type ProjectionStore,
  type ProjectionTableName,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteProjectionStore } from '../src/store.js';

import { FIRST_BLOB, SECOND_BLOB, realizationRow, sampleBlobRows, sampleExtentRows } from './fixtures.js';

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

/**
 * One resolution context as a command would declare it, in the smallest shape
 * that still touches all five context-scoped tables.
 *
 * `sampleExtentRows` builds one fixed context and is what the round-trip tests
 * want; the additive tests need several contexts under one key, and need to tell
 * one write's version of a context from another's.
 */
interface ContextFixture {
  /** The context these rows belong to — `extentId` and `contextId` alike. */
  readonly contextId: string;
  /** The identity this context realizes, and the one the context-less tables carry. */
  readonly resourceId: string;
  /** The realized path. Varying it is how a rewrite is told from the write before it. */
  readonly path?: string;
  /** When present, the context also carries one realization condition. */
  readonly condition?: string;
}

/**
 * Extent rows declaring exactly the given contexts.
 *
 * The three context-less tables (`roots`, `resources`, `resourceTags`) are
 * deduplicated by their own primary key, because a bundle carrying one identity
 * twice is a caller bug rather than a case the store is asked to absorb — two
 * contexts realizing one file contribute one identity row, and that row is what
 * the merge path is asserted on.
 *
 * @param contexts - The contexts this write declares; empty is legal and means a
 *   write that names no context at all
 * @param rootId - The root these rows belong to
 * @returns The eight extent-scoped tables
 */
function extentBundle(contexts: readonly ContextFixture[], rootId: string = KEY.rootId): ExtentScopedRows {
  const identities = [...new Map(contexts.map((fixture) => [fixture.resourceId, fixture])).values()];
  const pathOf = (fixture: ContextFixture): string => fixture.path ?? `docs/${fixture.contextId}.md`;
  return {
    roots: [{ id: rootId, path: '/corpus' }],
    resources: identities.map((fixture) => ({
      resourceId: fixture.resourceId,
      kind: 'file',
      origin: 'filesystem',
      observed: true,
      fromEnumeration: false,
      vatId: null,
    })),
    resourceRealizations: contexts.map((fixture) =>
      realizationRow({
        resourceId: fixture.resourceId,
        extentId: fixture.contextId,
        path: pathOf(fixture),
      }),
    ),
    resourceExtents: contexts.map((fixture) => ({
      resourceId: fixture.resourceId,
      extentId: fixture.contextId,
    })),
    // `value: null` on purpose — this is the row whose key column is nullable,
    // and the one an `=` comparison in the merge path fails to delete.
    resourceTags: identities.map((fixture) => ({
      resourceId: fixture.resourceId,
      tag: 'kind',
      value: null,
      source: 'filename',
    })),
    realizationConditions: contexts
      .filter((fixture) => fixture.condition !== undefined)
      .map((fixture) => ({
        extentId: fixture.contextId,
        path: pathOf(fixture),
        code: 'REALIZATION_PATH_COLLISION',
        severity: 'warning',
        message: fixture.condition ?? '',
        resourceId: null,
        sourcePath: null,
        sourceLine: null,
        sourceRef: null,
        targetExists: null,
        matchedPattern: null,
        matchedPayload: null,
      })),
    resolutionContexts: contexts.map((fixture) => ({
      contextId: fixture.contextId,
      species: 'extent',
      kind: 'filesystem',
      rootId,
      extentContextId: null,
      role: null,
    })),
    zoneProvenance: contexts.map((fixture) => ({
      contextId: fixture.contextId,
      contributorId: fixture.contextId,
      parameterSet: { include: ['**/*.md'], depth: 0 },
      extentDigest: `digest-${fixture.contextId}`,
    })),
  };
}

/** The filesystem extent's context — the one every command over a tree declares. */
const FS_CONTEXT = 'ext-fs';

/** A closure extent, the kind only the broader command declares. */
const SKILL_CONTEXT = 'ext-skill-1';

/** A second closure extent, so "kept" cannot be satisfied by keeping one of them. */
const OTHER_SKILL_CONTEXT = 'ext-skill-2';

/** An identity two contexts both realize, which is what the merge path is about. */
const SHARED_IDENTITY = 'res-1';

/** A broad command's answer: the filesystem extent plus a closure extent per skill. */
const BROAD: readonly ContextFixture[] = [
  { contextId: FS_CONTEXT, resourceId: 'res-fs' },
  { contextId: SKILL_CONTEXT, resourceId: 'res-skill-1' },
  { contextId: OTHER_SKILL_CONTEXT, resourceId: 'res-skill-2' },
];

/**
 * Every context id a stored extent holds, in a stable order.
 *
 * @param extent - What `readExtent` returned
 * @returns The context ids, sorted
 */
function contextsOf(extent: ExtentScopedRows | undefined): readonly string[] {
  return [...(extent?.resolutionContexts ?? [])]
    .map((row) => row.contextId)
    .sort((left, right) => left.localeCompare(right));
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

  it('absorbs the same write twice without duplicating a row', async () => {
    // Not "replaces the key": the key is a tree, and this write names one
    // context of it. What is asserted is only that re-declaring the same
    // context and the same identities leaves one of each.
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));

    expect((await store.readExtent(KEY))?.resources).toHaveLength(1);
    expect((await store.readExtent(KEY))?.resourceTags).toHaveLength(1);
  });
});

describe('extents are additive at context granularity', () => {
  it('keeps the contexts a narrower write does not name', async () => {
    // The regression this whole design exists for. A broad run declares three
    // contexts; a narrow run over the same tree declares one. Before the write
    // became additive the narrow run deleted the whole key range, so the broad
    // run's two closure extents vanished with no error anywhere.
    await store.writeExtent(KEY, extentBundle(BROAD));
    await store.writeExtent(KEY, extentBundle([
      { contextId: FS_CONTEXT, resourceId: 'res-fs', path: 'docs/rewritten.md' },
    ]));

    const read = await store.readExtent(KEY);
    expect(contextsOf(read)).toEqual([FS_CONTEXT, SKILL_CONTEXT, OTHER_SKILL_CONTEXT]);
    expect(read?.resourceRealizations.filter((row) => row.extentId === SKILL_CONTEXT)).toHaveLength(1);
    expect(read?.resourceExtents.filter((row) => row.extentId === OTHER_SKILL_CONTEXT)).toHaveLength(1);
    expect(read?.zoneProvenance.map((row) => row.contextId).sort((left, right) => left.localeCompare(right)))
      .toEqual([FS_CONTEXT, SKILL_CONTEXT, OTHER_SKILL_CONTEXT]);
    // …and the context the narrow run did name is its version, not the old one.
    expect(read?.resourceRealizations.filter((row) => row.extentId === FS_CONTEXT)
      .map((row) => row.path)).toEqual(['docs/rewritten.md']);
  });

  it('replaces a rewritten context rather than appending to it', async () => {
    await store.writeExtent(KEY, extentBundle([
      { contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY, path: 'docs/first.md' },
    ]));
    await store.writeExtent(KEY, extentBundle([
      { contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY, path: 'docs/second.md' },
    ]));

    const read = await store.readExtent(KEY);
    expect(read?.resourceRealizations).toHaveLength(1);
    expect(read?.resourceRealizations[0]?.path).toBe('docs/second.md');
    expect(read?.resolutionContexts).toHaveLength(1);
    expect(read?.zoneProvenance).toHaveLength(1);
  });

  it('drops a row the rewritten context no longer produces', async () => {
    // A context is cleared across every context-scoped table, not only the
    // tables the new bundle happens to carry rows for. Clearing per table would
    // leave this condition behind forever, since the rewrite names no condition
    // and so would name no context in that table.
    await store.writeExtent(KEY, extentBundle([
      { contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY, condition: 'collided' },
    ]));
    expect((await store.readExtent(KEY))?.realizationConditions).toHaveLength(1);

    await store.writeExtent(KEY, extentBundle([{ contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY }]));
    expect((await store.readExtent(KEY))?.realizationConditions).toEqual([]);
  });

  it('merges a context-less row across two writes, null key column included', async () => {
    // 🪤 `resource_tags` keys on a nullable `value`, and `= NULL` is never true:
    // a merge comparing with `=` deletes nothing here and the insert that
    // follows leaves two identical rows. Two contexts realizing one identity is
    // the ordinary case, so this would accumulate on every write.
    await store.writeExtent(KEY, extentBundle([{ contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY }]));
    await store.writeExtent(KEY, extentBundle([{ contextId: SKILL_CONTEXT, resourceId: SHARED_IDENTITY }]));

    const read = await store.readExtent(KEY);
    expect(read?.resourceTags).toHaveLength(1);
    expect(read?.resourceTags[0]?.value).toBeNull();
    expect(read?.resources).toHaveLength(1);
    expect(read?.roots).toHaveLength(1);
    // Both contexts survive — the merge is about the identity, not the context.
    expect(contextsOf(read)).toEqual([FS_CONTEXT, SKILL_CONTEXT]);
  });

  it('records the key on a write that names no context, disturbing nothing', async () => {
    await store.writeExtent(KEY, extentBundle(BROAD));
    await store.writeExtent(KEY, extentBundle([]));

    const read = await store.readExtent(KEY);
    expect(read).toBeDefined();
    expect(contextsOf(read)).toEqual([FS_CONTEXT, SKILL_CONTEXT, OTHER_SKILL_CONTEXT]);
    expect(read?.roots).toHaveLength(1);
  });

  it('keeps written-but-empty distinguishable from never-written after an additive write', async () => {
    // The manifest row is the only thing that tells them apart, and an additive
    // write must still record it — otherwise a tree whose contexts were all
    // written by someone else reads as a miss.
    await store.writeExtent(KEY, { ...extentBundle([]), roots: [] });

    expect(await store.readExtent(KEY)).toBeDefined();
    expect(await store.readExtent({ ...KEY, treeHash: 'tree-never-written' })).toBeUndefined();
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
