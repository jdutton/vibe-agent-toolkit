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
import { DatabaseSync } from 'node:sqlite';

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

import {
  FIRST_BLOB,
  SECOND_BLOB,
  contentKey,
  declinedBlobRows,
  realizationRow,
  sampleBlobRows,
  sampleExtentRows,
} from './fixtures.js';

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
    expectSchemaValid(read, ['blobs', 'blobReferences', 'blobSections', 'blobConditions', 'harnessBlobFacts', 'harnessBlobImports']);
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
    await store.writeBlobFacts({ ...bare, blobReferences: [], blobSections: [], blobConditions: [], harnessBlobFacts: [], harnessBlobImports: [] });

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

  it('keeps a key\'s harness facts when a later write of that key carries none', async () => {
    // Root A's run reached the blob and derived its harness facts; root B's run
    // holds the same bytes without reaching them, so it writes the key's blob
    // rows and no harness rows. Clearing the whole key would delete A's facts,
    // and every later hit on A would read the absence as "never derived".
    const rootA = sampleBlobRows();
    expect(rootA.harnessBlobFacts.length).toBeGreaterThan(0);
    expect(rootA.harnessBlobImports.length).toBeGreaterThan(0);
    await store.writeBlobFacts(rootA);

    await store.writeBlobFacts({ ...rootA, harnessBlobFacts: [], harnessBlobImports: [] });

    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.blobs).toHaveLength(1);
    expect(read.harnessBlobFacts).toEqual(rootA.harnessBlobFacts);
    expect(read.harnessBlobImports).toEqual(rootA.harnessBlobImports);
  });

  it('replaces a key\'s harness facts for a pair a later write carries', async () => {
    const first = sampleBlobRows();
    await store.writeBlobFacts(first);
    const [facts] = first.harnessBlobFacts;
    if (facts === undefined) throw new Error('fixture: sampleBlobRows carries no harness facts');

    await store.writeBlobFacts({ ...first, harnessBlobFacts: [{ ...facts, injectedTokens: facts.injectedTokens + 1 }], harnessBlobImports: [] });

    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.harnessBlobFacts.map((row) => row.injectedTokens)).toEqual([facts.injectedTokens + 1]);
    expect(read.harnessBlobImports).toEqual([]);
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
      ...empty, blobs: [], blobReferences: [], blobSections: [], blobConditions: [], harnessBlobFacts: [], harnessBlobImports: [],
    })).resolves.toBeUndefined();
  });

  it('holds a blob the derivation stage declined to parse, which has no blobs row', async () => {
    // The shape every binary file in a corpus produces. This store used to
    // REFUSE it outright — see the header of `writeBlobFacts` — which made
    // `vat inventory` cache nothing at all on any root shipping one `.so`,
    // `.pyc` or image, while exiting 0.
    await store.writeBlobFacts(declinedBlobRows(FIRST_BLOB));

    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.blobs).toEqual([]);
    expect(read.blobConditions).toHaveLength(1);
    expect(read.blobConditions[0]?.code).toBe('BLOB_NOT_TEXT');
  });

  it('does not accumulate a declined blob\'s condition across rewrites', async () => {
    // The hazard the refusal was guarding, kept as an assertion instead: a
    // key absent from the bundle's `blobs` table used to fall outside the
    // range the write clears, so its rows would pile up one copy per write —
    // silently, since `blob_conditions` keys on a nullable `line` and so
    // cannot be deduplicated by a conflict clause.
    await store.writeBlobFacts(declinedBlobRows(FIRST_BLOB));
    await store.writeBlobFacts(declinedBlobRows(FIRST_BLOB));
    await store.writeBlobFacts(declinedBlobRows(FIRST_BLOB));

    const read = await store.readBlobFacts([FIRST_BLOB]);
    expect(read.blobConditions).toHaveLength(1);
  });

  it('leaves a declined blob alone while a parsed one is rewritten', async () => {
    await store.writeBlobFacts(declinedBlobRows(FIRST_BLOB));
    await store.writeBlobFacts(sampleBlobRows(SECOND_BLOB));
    await store.writeBlobFacts(sampleBlobRows(SECOND_BLOB));

    const read = await store.readBlobFacts([FIRST_BLOB, SECOND_BLOB]);
    expect(read.blobs.map((row) => row.contentKey)).toEqual([SECOND_BLOB]);
    expect(read.blobConditions.filter((row) => row.blob === FIRST_BLOB)).toHaveLength(1);
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
      'resourceTags', 'realizationConditions', 'claudeRulePatterns', 'resolutionContexts',
      'zoneProvenance',
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
      resourceTags: [], realizationConditions: [], claudeRulePatterns: [],
      resolutionContexts: [], zoneProvenance: [],
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

/**
 * How many rows each extent-scoped table holds for one tree, read from the file
 * rather than through the store.
 *
 * 🪤 Row counts, never file size. An eviction that deleted only the `extents`
 * manifest row would make {@link ProjectionStore.readExtent} answer `undefined`
 * — a perfect-looking miss — while all eight tables kept their rows forever, and
 * the store would go on growing exactly as before. Only a count taken outside
 * the store can tell a reclaimed extent from a hidden one. File size cannot:
 * SQLite allocates by page, so an empty store and a populated one are both
 * 118,784 bytes at the sizes these fixtures produce.
 *
 * @param key - The tree to count
 * @returns Table name to row count, for every extent-scoped table
 */
function storedRowCounts(key: ExtentKey): Record<string, number> {
  const database = openStoreFile();
  try {
    const counts: Record<string, number> = {};
    for (const spec of Object.values(PROJECTION_TABLES)) {
      if (spec.scope === 'extent') counts[spec.name] = countExtentRows(database, spec.name, key);
    }
    return counts;
  } finally {
    database.close();
  }
}

/** A second, read-only connection onto the store file the suite is exercising. */
function openStoreFile(): DatabaseSync {
  return new DatabaseSync(safePath.join(directory, 'projection.db'), { readOnly: true });
}

/**
 * Rows one extent-scoped table holds for one tree, on a caller-supplied
 * connection.
 *
 * The connection is a parameter rather than opened here because one caller needs
 * several counts inside ONE `BEGIN DEFERRED` snapshot — see the read-tearing
 * case — and a helper that opened its own would take a fresh snapshot per call
 * and could never observe a torn read.
 */
function countExtentRows(database: DatabaseSync, table: string, key: ExtentKey): number {
  return (database
    .prepare(`SELECT COUNT(*) AS total FROM "${table}" WHERE "storeRootId" = ? AND "storeTreeHash" = ?`)
    .get(key.rootId, key.treeHash) as { total: number }).total;
}

/**
 * A store with a deliberately tiny retention, so a handful of writes reaches the
 * limit that a real run reaches after a handful of edits.
 *
 * The default is a production choice about how many recent trees are worth
 * keeping; these tests are about the mechanism, and a fixture that had to write
 * the default number of extents to observe it would be slower and no more
 * convincing.
 */
function openWithRetention(retainedExtentsPerRoot: number): ProjectionStore {
  return openSqliteProjectionStore({ directory, retainedExtentsPerRoot });
}

/** Total rows a tree occupies across every extent-scoped table. */
function storedRowTotal(key: ExtentKey): number {
  return Object.values(storedRowCounts(key)).reduce((total, count) => total + count, 0);
}

/** A tree of one root, so a sequence of writes reads as a sequence of edits. */
function treeKey(hash: string, rootId: string = KEY.rootId): ExtentKey {
  return { rootId, treeHash: hash };
}

describe('eviction', () => {
  it('bounds how many ROOTS it holds, dropping the least recently written root whole', async () => {
    // ⛔ Retention is per root, so every distinct root path — a worktree, a CI
    // job directory, a subdirectory a command ran from — kept its trees forever.
    // Six copies of one repository measured six roots and six stored trees, none
    // ever reclaimed, in a store that is on by default.
    const evicting = openSqliteProjectionStore({ directory, retainedExtentsPerRoot: 3, retainedRoots: 2 });
    const first = treeKey('tree-1', 'root-first');
    await evicting.writeExtent(first, extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-1', 'root-second'), extentBundle(BROAD));
    expect(await store.readExtent(first)).toBeDefined();

    await evicting.writeExtent(treeKey('tree-1', 'root-third'), extentBundle(BROAD));
    await evicting.close();

    expect(await store.readExtent(first)).toBeUndefined();
    expect(storedRowTotal(first)).toBe(0);
    expect(await store.readExtent(treeKey('tree-1', 'root-second'))).toBeDefined();
    expect(await store.readExtent(treeKey('tree-1', 'root-third'))).toBeDefined();
  });

  it('counts a root as recent when ANY of its trees was written recently', async () => {
    // A busy root rewriting its newest tree must not be aged out behind a quiet
    // one, which is the reason retention was per root in the first place.
    const evicting = openSqliteProjectionStore({ directory, retainedExtentsPerRoot: 3, retainedRoots: 2 });
    await evicting.writeExtent(treeKey('tree-1', 'root-busy'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-1', 'root-quiet'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2', 'root-busy'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-1', 'root-new'), extentBundle(BROAD));
    await evicting.close();

    expect(await store.readExtent(treeKey('tree-1', 'root-quiet'))).toBeUndefined();
    expect(await store.readExtent(treeKey('tree-2', 'root-busy'))).toBeDefined();
    expect(await store.readExtent(treeKey('tree-1', 'root-new'))).toBeDefined();
  });

  it('keeps every tree while the root is under its retention limit', async () => {
    // The negative control. Without it, an eviction that deleted everything it
    // touched would satisfy every other case in this block.
    const evicting = openWithRetention(3);
    await evicting.writeExtent(treeKey('tree-1'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
    await evicting.close();

    expect(contextsOf(await store.readExtent(treeKey('tree-1')))).toEqual([FS_CONTEXT, SKILL_CONTEXT, OTHER_SKILL_CONTEXT].sort((l, r) => l.localeCompare(r)));
    expect(await store.readExtent(treeKey('tree-2'))).toBeDefined();
  });

  it('reclaims the ROWS of the oldest tree once the limit is passed, not just its manifest row', async () => {
    // The measured defect: the key is a whole-repository tree hash, so any edit
    // anywhere mints a brand new full extent. Five edits took a real store from
    // 9.83 MB / 18,079 rows to 58.49 MB / 108,474 rows with six extents held,
    // and nothing ever reclaimed one.
    const evicting = openWithRetention(2);
    const oldest = treeKey('tree-1');
    await evicting.writeExtent(oldest, extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
    const beforeEviction = storedRowTotal(oldest);

    await evicting.writeExtent(treeKey('tree-3'), extentBundle(BROAD));
    await evicting.close();

    expect(beforeEviction).toBeGreaterThan(0);
    expect(storedRowTotal(oldest)).toBe(0);
    // Every table, not the total: a prune that cleared seven of the eight would
    // leave a growing tier behind a green sum.
    expect(Object.values(storedRowCounts(oldest)).every((count) => count === 0)).toBe(true);
    expect(await store.readExtent(oldest)).toBeUndefined();
    expect(storedRowTotal(treeKey('tree-3'))).toBe(beforeEviction);
  });

  it('leaves another root alone, however old its trees are', async () => {
    // The store is shared: two projects under one cache namespace write into the
    // same file. A prune that ordered by age across the whole table would let a
    // busy repository evict a quiet one's only extent.
    const other = treeKey('tree-old', 'root-2');
    const evicting = openWithRetention(1);
    await evicting.writeExtent(other, extentBundle(BROAD, 'root-2'));
    await evicting.writeExtent(treeKey('tree-1'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
    await evicting.close();

    expect(await store.readExtent(other)).toBeDefined();
    expect(storedRowTotal(other)).toBeGreaterThan(0);
    expect(await store.readExtent(treeKey('tree-1'))).toBeUndefined();
  });

  it('never evicts the tree it is writing, at a retention of one', async () => {
    // The writer's own protection, and it is structural rather than a special
    // case: the extent being written is by construction the most recently
    // written one, so recency ordering can never select it. That is what makes
    // it safe for `vat build`'s second phase to read what its first phase wrote.
    const evicting = openWithRetention(1);
    for (const hash of ['tree-1', 'tree-2', 'tree-3']) {
      await evicting.writeExtent(treeKey(hash), extentBundle(BROAD));
      expect(await evicting.readExtent(treeKey(hash))).toBeDefined();
    }
    await evicting.close();
  });

  it('holds at least one tree however low the caller sets the retention', async () => {
    // A retention of zero asks for a cache that evicts the extent it is writing
    // the instant it commits — a store that can never hit, which is strictly
    // worse than no store because it pays every write cost for nothing. Clamped
    // rather than rejected: nothing in the CLI surfaces this option, so the only
    // way to reach it is a programmatic caller, and turning its argument into a
    // thrown error would be a worse answer than the obvious floor.
    const evicting = openWithRetention(0);
    await evicting.writeExtent(treeKey('tree-1'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
    await evicting.close();

    expect(await store.readExtent(treeKey('tree-2'))).toBeDefined();
    expect(storedRowTotal(treeKey('tree-2'))).toBeGreaterThan(0);
    expect(await store.readExtent(treeKey('tree-1'))).toBeUndefined();
  });

  it('does not tear a read another connection is in the middle of', async () => {
    // ⚠️ The one way eviction could corrupt rather than merely cool. This store
    // reads under an explicit `BEGIN DEFERRED` precisely so every table in one
    // read sees one snapshot; the question eviction raises is whether a delete
    // committed by another connection can reach INTO that snapshot. It cannot —
    // WAL keeps the reader on the version it started with — and the assertion
    // below is what turns that from a claim about SQLite into a fact about this
    // store's file.
    const victim = treeKey('tree-1');
    await store.writeExtent(victim, extentBundle(BROAD));

    const reader = openStoreFile();
    try {
      reader.exec('BEGIN DEFERRED');
      const countFor = (table: string): number => countExtentRows(reader, table, victim);
      // First table read INSIDE the snapshot, before anything is evicted.
      const contextsSeen = countFor(PROJECTION_TABLES.resolutionContexts.name);
      expect(contextsSeen).toBeGreaterThan(0);

      const evicting = openWithRetention(1);
      await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
      await evicting.close();

      // Same snapshot, a DIFFERENT table, read after the eviction committed. A
      // torn read would show this one emptied while the first was not.
      expect(countFor(PROJECTION_TABLES.resourceRealizations.name)).toBeGreaterThan(0);
      expect(countFor(PROJECTION_TABLES.resolutionContexts.name)).toBe(contextsSeen);
      reader.exec('COMMIT');

      // And once the snapshot is released, the eviction is visible — otherwise
      // the assertions above would be satisfied by an eviction that never ran.
      expect(countFor(PROJECTION_TABLES.resolutionContexts.name)).toBe(0);
    } finally {
      reader.close();
    }
  });

  it('gives the freed pages back to the file instead of only to a freelist', async () => {
    // Deleting rows alone would bound the store's growth — SQLite reuses freed
    // pages — but would never shrink the file, so an operator measuring with du
    // sees a 58 MB cache that "was fixed". The store is created with incremental
    // auto-vacuum so a prune can hand the pages back.
    const evicting = openWithRetention(1);
    await evicting.writeExtent(treeKey('tree-1'), extentBundle(BROAD));
    const peak = filePages();

    await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
    await evicting.close();

    expect(filePages().pageCount).toBeLessThanOrEqual(peak.pageCount);
    expect(filePages().freelist).toBe(0);
    expect(filePages().autoVacuum).toBe(2);
  });
});

/**
 * A store whose blob window is small enough to cross in a handful of writes.
 *
 * The production window is 50,000 content keys, sized from a measured ~5.3 KB
 * per key; writing that many here would take minutes and prove the same thing.
 */
function openWithBlobWindow(retainedBlobKeys: number): ProjectionStore {
  return openSqliteProjectionStore({ directory, retainedBlobKeys });
}

/**
 * Rows held for one content key across every blob-scoped table, read from the
 * file rather than through the store.
 *
 * 🪤 All four tables, and never `blobs` alone. A blob the derivation stage
 * declined to parse has a `blob_conditions` row and no `blobs` row at all, so an
 * eviction that reclaimed only `blobs` would leave the declined tier growing
 * behind a green count — which is exactly the tier a binary-heavy corpus fills.
 *
 * @param key - The content key to count
 * @returns Table name to row count
 */
function blobRowCounts(key: string): Record<string, number> {
  const database = openStoreFile();
  try {
    const counts: Record<string, number> = {};
    for (const spec of Object.values(PROJECTION_TABLES)) {
      if (spec.scope !== 'blob') continue;
      const [keyColumn] = spec.primaryKey;
      counts[spec.name] = (database
        .prepare(`SELECT COUNT(*) AS total FROM "${spec.name}" WHERE "${String(keyColumn)}" = ?`)
        .get(key) as { total: number }).total;
    }
    return counts;
  } finally {
    database.close();
  }
}

/** Total rows one content key occupies across every blob-scoped table. */
function blobRowTotal(key: string): number {
  return Object.values(blobRowCounts(key)).reduce((total, count) => total + count, 0);
}

/** How many content keys the blob manifest is tracking. */
function trackedBlobKeys(): number {
  const database = openStoreFile();
  try {
    return (database.prepare('SELECT COUNT(*) AS total FROM "blob_keys"').get() as { total: number }).total;
  } finally {
    database.close();
  }
}

describe('the blob tier is bounded', () => {
  it('keeps every content key while the store is under its window', async () => {
    // The negative control, and the reason every assertion below means
    // something: an eviction that reclaimed whatever it touched would satisfy
    // all of them.
    const evicting = openWithBlobWindow(3);
    await evicting.writeBlobFacts(sampleBlobRows(contentKey('a')));
    await evicting.writeBlobFacts(sampleBlobRows(contentKey('b')));
    await evicting.close();

    expect(blobRowTotal(contentKey('a'))).toBeGreaterThan(0);
    expect(blobRowTotal(contentKey('b'))).toBeGreaterThan(0);
    expect(trackedBlobKeys()).toBe(2);
  });

  it('reclaims the ROWS of the least recently written key once the window is passed', async () => {
    // The defect this closes: blob rows carry no tree and no root, so extent
    // eviction could never attribute them, and the tier grew with nothing but
    // the release namespace rotating to bound it. Measured on a 12,602-file
    // adopter tree it is 153,245 of the store's 193,605 rows.
    const evicting = openWithBlobWindow(2);
    const oldest = contentKey('a');
    await evicting.writeBlobFacts(sampleBlobRows(oldest));
    await evicting.writeBlobFacts(sampleBlobRows(contentKey('b')));
    const beforeEviction = blobRowTotal(oldest);

    await evicting.writeBlobFacts(sampleBlobRows(contentKey('c')));
    await evicting.close();

    expect(beforeEviction).toBeGreaterThan(0);
    // Every table, not the total: a prune that cleared all but one would
    // leave a growing tier behind a green sum.
    expect(blobRowCounts(oldest)).toEqual({
      blobs: 0, blob_references: 0, blob_sections: 0, blob_conditions: 0, harness_blob_facts: 0, harness_blob_imports: 0,
    });
    expect(trackedBlobKeys()).toBe(2);
    // And the survivors really did survive — an eviction that emptied the tier
    // would pass the line above and be a cache that cannot hit.
    expect(blobRowTotal(contentKey('c'))).toBe(beforeEviction);
    expect(blobRowTotal(contentKey('b'))).toBeGreaterThan(0);
  });

  it('reclaims a DECLINED blob, which has no blobs row to be found through', async () => {
    // `blob_conditions` is the tier a binary-heavy corpus fills, and it is the
    // one an eviction keyed on `blobs` would never see.
    const evicting = openWithBlobWindow(1);
    const declined = contentKey('d');
    await evicting.writeBlobFacts(declinedBlobRows(declined));
    expect(blobRowCounts(declined)['blobs']).toBe(0);
    expect(blobRowTotal(declined)).toBeGreaterThan(0);

    await evicting.writeBlobFacts(sampleBlobRows(contentKey('e')));
    await evicting.close();

    expect(blobRowTotal(declined)).toBe(0);
  });

  it('never evicts the keys it is writing, at a window of one', async () => {
    // Structural rather than a special case, exactly as for extents: the keys a
    // write records are by construction the most recently written, so recency
    // ordering cannot select them. `INSERT OR REPLACE` re-inserts, which is why
    // the `rowid` tie-break holds for a REFRESHED key too.
    const evicting = openWithBlobWindow(1);
    for (const seed of ['a', 'b', 'c']) {
      await evicting.writeBlobFacts(sampleBlobRows(contentKey(seed)));
      const held = await evicting.readBlobFacts([contentKey(seed)]);
      expect(held.blobs).toHaveLength(1);
    }
    await evicting.close();
  });

  it('never evicts the keys it is writing when ONE write names more keys than the window', async () => {
    // ⛔ The case the one-key-per-write test above cannot see. Every key of a
    // single write shares its timestamp and holds the newest rowids, but an
    // OFFSET of the window still cut the write's own oldest keys — and the
    // coverage check is all-or-nothing, so one missing key made every run of a
    // tree larger than the window a full re-derivation that could never hit.
    const evicting = openWithBlobWindow(3);
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((seed) => contentKey(seed));
    await evicting.writeBlobFacts({
      blobs: [], blobReferences: [], blobSections: [], harnessBlobFacts: [], harnessBlobImports: [],
      blobConditions: keys.flatMap((key) => declinedBlobRows(key).blobConditions),
    });
    const held = await evicting.readBlobFacts(keys);
    await evicting.close();

    expect(new Set(held.blobConditions.map((row) => row.blob))).toEqual(new Set(keys));
  });

  it('trims back to the window on the next write, and only then', async () => {
    // The oversized write above holds more than the window until a later write
    // reclaims the surplus — so the bound is still a bound.
    const evicting = openWithBlobWindow(2);
    await evicting.writeBlobFacts({
      blobs: [], blobReferences: [], blobSections: [], harnessBlobFacts: [], harnessBlobImports: [],
      blobConditions: ['a', 'b', 'c', 'd'].flatMap((seed) => declinedBlobRows(contentKey(seed)).blobConditions),
    });
    expect(trackedBlobKeys()).toBe(4);

    await evicting.writeBlobFacts(sampleBlobRows(contentKey('e')));
    await evicting.close();

    expect(trackedBlobKeys()).toBe(2);
  });

  it('holds at least one key however low the caller sets the window', async () => {
    // Clamped rather than rejected, for the reason the extent retention is:
    // nothing in the CLI surfaces this option, and a window of zero would delete
    // the rows it just wrote — a store that pays every write cost and can never
    // hit.
    const evicting = openWithBlobWindow(0);
    await evicting.writeBlobFacts(sampleBlobRows(contentKey('a')));
    await evicting.close();

    expect(blobRowTotal(contentKey('a'))).toBeGreaterThan(0);
  });

  it('adopts the keys of a store written before the manifest existed, as the oldest there are', async () => {
    // 🪤 Without adoption the bound holds only for stores created after it
    // shipped: the cache namespace is per RELEASE, so a store an earlier build
    // of the same release wrote keeps blob rows the manifest never names — rows
    // no eviction can see, under code that claims a ceiling.
    await store.writeBlobFacts(sampleBlobRows(contentKey('a')));
    await store.writeBlobFacts(sampleBlobRows(contentKey('b')));
    await store.close();
    dropBlobManifest();
    expect(blobRowTotal(contentKey('a'))).toBeGreaterThan(0);

    // Reopening is what adopts; the write that follows is what evicts.
    const evicting = openWithBlobWindow(1);
    expect(trackedBlobKeys()).toBe(2);
    await evicting.writeBlobFacts(sampleBlobRows(contentKey('c')));
    await evicting.close();
    // Reassigned so the suite's own `afterEach` closes a live store.
    store = openSqliteProjectionStore({ directory });

    expect(blobRowTotal(contentKey('a'))).toBe(0);
    expect(blobRowTotal(contentKey('b'))).toBe(0);
    expect(blobRowTotal(contentKey('c'))).toBeGreaterThan(0);
  });
});

/** Turn the store on disk back into a pre-manifest one. */
function dropBlobManifest(): void {
  const database = new DatabaseSync(safePath.join(directory, 'projection.db'));
  try {
    database.exec('DROP TABLE "blob_keys"');
  } finally {
    database.close();
  }
}

/** The database file's page accounting, read outside the store. */
function filePages(): { pageCount: number; freelist: number; autoVacuum: number } {
  const database = openStoreFile();
  try {
    const read = (pragma: string, field: string): number =>
      Number((database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[field]);
    return {
      pageCount: read('page_count', 'page_count'),
      freelist: read('freelist_count', 'freelist_count'),
      autoVacuum: read('auto_vacuum', 'auto_vacuum'),
    };
  } finally {
    database.close();
  }
}
