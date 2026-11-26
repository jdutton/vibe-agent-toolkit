/**
 * The store's semantics, against a real database in a temporary directory.
 *
 * The strongest assertion available is that a row written and read back still
 * **validates against its own Zod schema** — that catches a `Date` returning as
 * a string, a boolean returning as a number and a JSON column returning as
 * text, none of which throw and all of which pass a shallow `toEqual` against a
 * fixture built the same wrong way.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  ALL_BLOB_REQUEST,
  ALL_EXTENT_REQUEST,
  AST_SYNTACTIC_FORMS,
  PROJECTION_TABLES,
  ReferenceSyntacticFormSchema,
  blobRowBytes,
  projectionColumnTypes,
  type BlobScopedRows,
  type ContentKey,
  emptyBlobRows,
  orderContentKeys,
  type ExtentKey,
  type ExtentScopedRows,
  type FactStore,
  type Projection,
  type ProjectionTableName,
  withPopulationRun,
} from '@vibe-agent-toolkit/resources';
import { BLOB_WRITER_CONTRACT, uncoveredBlobWrite, type BlobWriterContractFactory } from '@vibe-agent-toolkit/resources/testing';
import { compareCodeUnits, isVatError, readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { __resetWorkCountersForTest } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateRunDatabase } from '../src/run-database.js';
import { EXTENTS_TABLE, allSpecs, blobKeyColumn } from '../src/schema-sql.js';
import { DEFAULT_BLOB_TIER_BUDGET_BYTES, PROJECTION_STORE_BUDGET_INVALID_CODE, openSqliteFactStore } from '../src/store.js';
import { encodeValue, type SqliteResultValue } from '../src/values.js';

import {
  FIRST_BLOB,
  SECOND_BLOB,
  contentKey,
  declinedBlobRows,
  hydrateEveryTable,
  realizationRow,
  sampleBlobRows,
  sampleExtentRows,
  sampleProjection,
} from './fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };

let directory: string;
let store: FactStore;

beforeEach(() => {
  directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-sqlite-'));
  store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
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
        targetFaultClass: null,
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
    claudeRulePatterns: [],
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

/**
 * {@link sampleBlobRows} with one `blobReferences` row of every syntactic form.
 *
 * @returns The bundle, and how many of its reference rows are of an AST form
 */
function everyFormRows(): { rows: BlobScopedRows; astRows: number } {
  const rows = sampleBlobRows();
  const [template] = rows.blobReferences;
  if (template === undefined) throw new Error('the sample bundle holds no reference row');
  const forms = ReferenceSyntacticFormSchema.options;
  const blobReferences = forms.map((syntacticForm, ordinal) => ({
    ...template,
    ordinal,
    syntacticForm,
    astIndex: AST_SYNTACTIC_FORMS.has(syntacticForm) ? ordinal : null,
  }));
  return { rows: { ...rows, blobReferences }, astRows: forms.filter((form) => AST_SYNTACTIC_FORMS.has(form)).length };
}

describe('a blob read states what it reads', () => {
  it('reads only the requested tables and forms', async () => {
    const { rows, astRows } = everyFormRows();
    await store.writeBlobFacts(uncoveredBlobWrite(rows));
    __resetWorkCountersForTest();

    const read = (await store.readBlobFacts([FIRST_BLOB], { tables: ['blobs', 'blobReferences'], referenceForms: AST_SYNTACTIC_FORMS })).rows;

    expect(Object.keys(read).sort((left, right) => left.localeCompare(right))).toEqual(['blobReferences', 'blobs']);
    expect(read.blobs).toEqual(rows.blobs);
    expect(read.blobReferences).toEqual(rows.blobReferences.filter((row) => AST_SYNTACTIC_FORMS.has(row.syntacticForm)));
    // The lexical rows are not decoded, so they are not counted.
    expect(readWorkCounters()['store.rows.decoded.persistent']).toBe(rows.blobs.length + astRows);
    expect(readWorkCounters()['store.reads.blob']).toBe(1);
    __resetWorkCountersForTest();
  });

  it('reads every row of every table for every table and every form', async () => {
    const { rows } = everyFormRows();
    await store.writeBlobFacts(uncoveredBlobWrite(rows));

    expect((await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows).toEqual(rows);
  });

  it('reads no reference row for an empty form set, and still reads the other tables', async () => {
    const { rows } = everyFormRows();
    await store.writeBlobFacts(uncoveredBlobWrite(rows));

    const read = (await store.readBlobFacts([FIRST_BLOB], { tables: ['blobs', 'blobReferences'], referenceForms: new Set() })).rows;
    expect(read).toEqual({ blobs: rows.blobs, blobReferences: [] });
  });
});

describe('blob facts', () => {
  it('round-trips every column kind back into schema-valid rows', async () => {
    const written = sampleBlobRows();
    await store.writeBlobFacts(uncoveredBlobWrite(written));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows as unknown as Record<string, readonly unknown[]>;
    expectSchemaValid(read, ['blobs', 'blobReferences', 'blobSections', 'blobConditions', 'harnessBlobFacts', 'harnessBlobImports', 'skillTextFacts', 'skillTextMatches']);
    expect(read).toEqual(written);
  });

  it('returns nothing for a key it has never seen — a miss, not an error', async () => {
    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toEqual([]);
    expect(read.blobReferences).toEqual([]);
  });

  it('reports presence through the blobs table, not through a child table', async () => {
    // A blob with no references legitimately has zero `blobReferences` rows;
    // a caller inferring "not cached" from that would re-parse it forever.
    const bare = sampleBlobRows();
    await store.writeBlobFacts(uncoveredBlobWrite({ ...bare, blobReferences: [], blobSections: [], blobConditions: [], harnessBlobFacts: [], harnessBlobImports: [] }));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toHaveLength(1);
    expect(read.blobReferences).toEqual([]);
  });

  it('is idempotent — writing the same facts twice does not duplicate a row', async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows()));
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows()));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toHaveLength(1);
    // The interesting one: `blob_conditions` keys on a nullable `line`, so a
    // conflict clause would NOT have deduplicated this row.
    expect(read.blobConditions).toHaveLength(1);
  });

  it('keeps a key\'s harness facts when a later write that covered the key carries none', async () => {
    // Root A's run reached the blob and derived its harness facts; root B's run
    // holds the same bytes without reaching them. Its read covered the key, so
    // it writes the key's blob rows and no harness rows and replaces nothing:
    // clearing the key would delete A's facts, and every later hit on A would
    // read the absence as "never derived".
    const rootA = sampleBlobRows();
    expect(rootA.harnessBlobFacts.length).toBeGreaterThan(0);
    expect(rootA.harnessBlobImports.length).toBeGreaterThan(0);
    await store.writeBlobFacts(uncoveredBlobWrite(rootA));

    await store.writeBlobFacts({
      rows: { ...rootA, harnessBlobFacts: [], harnessBlobImports: [] },
      coveredAtRead: [FIRST_BLOB],
      settledAtRead: [],
    });

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toHaveLength(1);
    expect(read.harnessBlobFacts).toEqual(rootA.harnessBlobFacts);
    expect(read.harnessBlobImports).toEqual(rootA.harnessBlobImports);
  });

  it('clears a REPLACED key\'s harness facts with the rest of its rows', async () => {
    // A key the write's read did not cover is replaced whole, partitioned rows
    // included, so its recorded bytes are exactly the rows that replaced it.
    // Another root's pairs for those bytes are derived again once — the cost of
    // a key that was uncovered or evicted.
    const rootA = sampleBlobRows();
    await store.writeBlobFacts(uncoveredBlobWrite(rootA));

    await store.writeBlobFacts(uncoveredBlobWrite({ ...rootA, harnessBlobFacts: [], harnessBlobImports: [] }));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toHaveLength(1);
    expect(read.harnessBlobFacts).toEqual([]);
    expect(read.harnessBlobImports).toEqual([]);
  });

  it('replaces a key\'s harness facts for a pair a later write carries', async () => {
    const first = sampleBlobRows();
    await store.writeBlobFacts(uncoveredBlobWrite(first));
    const [facts] = first.harnessBlobFacts;
    if (facts === undefined) throw new Error('fixture: sampleBlobRows carries no harness facts');

    await store.writeBlobFacts(uncoveredBlobWrite({ ...first, harnessBlobFacts: [{ ...facts, injectedTokens: facts.injectedTokens + 1 }], harnessBlobImports: [] }));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.harnessBlobFacts.map((row) => row.injectedTokens)).toEqual([facts.injectedTokens + 1]);
    expect(read.harnessBlobImports).toEqual([]);
  });

  it('keeps one blob\'s facts when another is rewritten', async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(FIRST_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(SECOND_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(SECOND_BLOB)));

    const read = (await store.readBlobFacts([FIRST_BLOB, SECOND_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toHaveLength(2);
  });

  it('returns only the keys asked for', async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(FIRST_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(SECOND_BLOB)));

    const read = (await store.readBlobFacts([SECOND_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs.map((row) => row.contentKey)).toEqual([SECOND_BLOB]);
  });

  it('accepts an empty key list without emitting an IN () that cannot parse', async () => {
    const read = (await store.readBlobFacts([], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs).toEqual([]);
  });

  it('accepts an empty bundle', async () => {
    const empty = sampleBlobRows();
    await expect(store.writeBlobFacts(uncoveredBlobWrite({
      ...empty, blobs: [], blobReferences: [], blobSections: [], blobConditions: [], harnessBlobFacts: [], harnessBlobImports: [],
    }))).resolves.toBeUndefined();
  });

  it('holds a blob the derivation stage declined to parse, which has no blobs row', async () => {
    // The shape every binary file in a corpus produces. This store used to
    // REFUSE it outright — see the header of `writeBlobFacts` — which made
    // `vat inventory` cache nothing at all on any root shipping one `.so`,
    // `.pyc` or image, while exiting 0.
    await store.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(FIRST_BLOB)));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
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
    await store.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(FIRST_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(FIRST_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(FIRST_BLOB)));

    const read = (await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobConditions).toHaveLength(1);
  });

  it('leaves a declined blob alone while a parsed one is rewritten', async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(FIRST_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(SECOND_BLOB)));
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(SECOND_BLOB)));

    const read = (await store.readBlobFacts([FIRST_BLOB, SECOND_BLOB], ALL_BLOB_REQUEST)).rows;
    expect(read.blobs.map((row) => row.contentKey)).toEqual([SECOND_BLOB]);
    expect(read.blobConditions.filter((row) => row.blob === FIRST_BLOB)).toHaveLength(1);
  });
});

describe('extents', () => {
  it('round-trips every column kind back into schema-valid rows', async () => {
    const written = sampleExtentRows(KEY.rootId);
    await store.writeExtent(KEY, written);

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST) as unknown as Record<string, readonly unknown[]>;
    expect(read).toBeDefined();
    expectSchemaValid(read, [
      'roots', 'resources', 'resourceRealizations', 'resourceExtents',
      'resourceTags', 'realizationConditions', 'claudeRulePatterns', 'resolutionContexts',
      'zoneProvenance',
    ]);
    expect(read).toEqual(written);
  });

  it('reads only the requested tables, and decodes only their rows', async () => {
    const written = sampleExtentRows(KEY.rootId);
    await store.writeExtent(KEY, written);
    __resetWorkCountersForTest();

    const read = await store.readExtent(KEY, { tables: ['resourceRealizations', 'realizationConditions', 'zoneProvenance'], steps: [] });
    expect(read).toEqual({
      resourceRealizations: written.resourceRealizations,
      realizationConditions: written.realizationConditions,
      zoneProvenance: written.zoneProvenance,
    });
    expect(readWorkCounters()['store.rows.decoded.persistent'])
      .toBe(written.resourceRealizations.length + written.realizationConditions.length + written.zoneProvenance.length);
  });

  it('restores an mtime as a Date, not as the string it was stored as', async () => {
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST);
    const [realization] = read?.resourceRealizations ?? [];
    expect(realization?.mtime).toBeInstanceOf(Date);
    expect(realization?.mtime?.toISOString()).toBe('2026-08-18T12:34:56.789Z');
  });

  it('reports a tree it has never seen as undefined', async () => {
    expect(await store.readExtent(KEY, ALL_EXTENT_REQUEST)).toBeUndefined();
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

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST);
    expect(read).toBeDefined();
    expect(read?.roots).toEqual([]);
    expect(await store.readExtent({ ...KEY, treeHash: 'tree-bbb' }, ALL_EXTENT_REQUEST)).toBeUndefined();
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

    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.resources.map((row) => row.resourceId)).toEqual(['res-1']);
    expect((await store.readExtent(other, ALL_EXTENT_REQUEST))?.resources.map((row) => row.resourceId)).toEqual(['res-2']);
  });

  it('keeps two roots at the same tree hash apart', async () => {
    // Two projects sharing a cache namespace is exactly the case the root half
    // of the key exists for.
    const other: ExtentKey = { rootId: 'root-2', treeHash: KEY.treeHash };
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.writeExtent(other, sampleExtentRows('root-2'));

    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.roots.map((row) => row.id)).toEqual(['root-1']);
    expect((await store.readExtent(other, ALL_EXTENT_REQUEST))?.roots.map((row) => row.id)).toEqual(['root-2']);
  });

  it('absorbs the same write twice without duplicating a row', async () => {
    // Not "replaces the key": the key is a tree, and this write names one
    // context of it. What is asserted is only that re-declaring the same
    // context and the same identities leaves one of each.
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));

    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.resources).toHaveLength(1);
    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.resourceTags).toHaveLength(1);
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

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST);
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

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST);
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
    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.realizationConditions).toHaveLength(1);

    await store.writeExtent(KEY, extentBundle([{ contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY }]));
    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.realizationConditions).toEqual([]);
  });

  it('merges a context-less row across two writes, null key column included', async () => {
    // 🪤 `resource_tags` keys on a nullable `value`, and `= NULL` is never true:
    // a merge comparing with `=` deletes nothing here and the insert that
    // follows leaves two identical rows. Two contexts realizing one identity is
    // the ordinary case, so this would accumulate on every write.
    await store.writeExtent(KEY, extentBundle([{ contextId: FS_CONTEXT, resourceId: SHARED_IDENTITY }]));
    await store.writeExtent(KEY, extentBundle([{ contextId: SKILL_CONTEXT, resourceId: SHARED_IDENTITY }]));

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST);
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

    const read = await store.readExtent(KEY, ALL_EXTENT_REQUEST);
    expect(read).toBeDefined();
    expect(contextsOf(read)).toEqual([FS_CONTEXT, SKILL_CONTEXT, OTHER_SKILL_CONTEXT]);
    expect(read?.roots).toHaveLength(1);
  });

  it('keeps written-but-empty distinguishable from never-written after an additive write', async () => {
    // The manifest row is the only thing that tells them apart, and an additive
    // write must still record it — otherwise a tree whose contexts were all
    // written by someone else reads as a miss.
    await store.writeExtent(KEY, { ...extentBundle([]), roots: [] });

    expect(await store.readExtent(KEY, ALL_EXTENT_REQUEST)).toBeDefined();
    expect(await store.readExtent({ ...KEY, treeHash: 'tree-never-written' }, ALL_EXTENT_REQUEST)).toBeUndefined();
  });
});

describe('lifetime', () => {
  it('reopens an existing store and still reads what was written', async () => {
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.close();

    store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
    expect((await store.readExtent(KEY, ALL_EXTENT_REQUEST))?.resources).toHaveLength(1);
  });

  it('rejects use after close rather than silently reopening', async () => {
    await store.close();
    await expect(store.readExtent(KEY, ALL_EXTENT_REQUEST)).rejects.toThrow(/closed/u);
    await expect(store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows()))).rejects.toThrow(/closed/u);
  });

  it('closes twice without complaint', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

/**
 * The last table of one scope, in declaration order: the one a read reaches last.
 *
 * @param scope - Which scope
 * @returns Its name
 */
function lastTableOfScope(scope: 'blob' | 'extent'): string {
  const name = Object.values(PROJECTION_TABLES).findLast((spec) => spec.scope === scope)?.name;
  if (name === undefined) throw new Error(`no ${scope}-scoped table`);
  return name;
}

/**
 * Drop one table from the store under `directory` behind the open store's back.
 *
 * @param directory - The store's directory
 * @param table - The table to drop
 */
function dropTable(directory: string, table: string): void {
  const writer = new DatabaseSync(safePath.join(directory, 'projection.db'));
  try {
    writer.exec(`DROP TABLE "${table}"`);
  } finally {
    writer.close();
  }
}

describe('a row this process already decoded from the file is counted as repeated', () => {
  /** The AST forms' complement: the lexical forms. */
  const LEXICAL_FORMS = new Set(ReferenceSyntacticFormSchema.options.filter((form) => !AST_SYNTACTIC_FORMS.has(form)));
  const REFERENCES_OF = (forms: ReadonlySet<string>) => ({ tables: ['blobReferences'] as const, referenceForms: forms as typeof AST_SYNTACTIC_FORMS });

  beforeEach(async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(everyFormRows().rows));
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    __resetWorkCountersForTest();
  });

  afterEach(() => {
    __resetWorkCountersForTest();
  });

  it('a second read of the same key, table and form counts every row again', async () => {
    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(0);
    const first = readWorkCounters()['store.rows.decoded.persistent'];

    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);

    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(first);
  });

  it('a read of the forms an earlier read left out repeats nothing, and one of the same forms repeats them', async () => {
    const { astRows } = everyFormRows();
    await store.readBlobFacts([FIRST_BLOB], REFERENCES_OF(AST_SYNTACTIC_FORMS));
    await store.readBlobFacts([FIRST_BLOB], REFERENCES_OF(LEXICAL_FORMS));
    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(0);

    await store.readBlobFacts([FIRST_BLOB], REFERENCES_OF(AST_SYNTACTIC_FORMS));

    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(astRows);
  });

  it('a run\'s reader asked for the AST forms, then every form, decodes each stored row once', async () => {
    // The query lane's request: every table, of `blobReferences` the AST forms.
    const narrow = { tables: ALL_BLOB_REQUEST.tables, referenceForms: AST_SYNTACTIC_FORMS };
    const stored = Object.values(everyFormRows().rows).reduce((sum, rows) => sum + rows.length, 0);

    await withPopulationRun(async (run) => {
      const reads = run.stored.of(store);
      await reads.blobs([FIRST_BLOB], narrow);
      await reads.blobs([FIRST_BLOB], ALL_BLOB_REQUEST);
    });

    expect(readWorkCounters()['store.rows.decoded.repeated'], 'no row decoded twice').toBe(0);
    expect(readWorkCounters()['store.rows.decoded.persistent'], 'every stored row of the key decoded').toBe(stored);
  });

  it('a second extent read of the same tree and table counts it again, and of another table nothing', async () => {
    const extent = sampleExtentRows(KEY.rootId);
    await store.readExtent(KEY, { tables: ['resources'], steps: [] });
    await store.readExtent(KEY, { tables: ['roots'], steps: [] });
    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(0);

    await store.readExtent(KEY, { tables: ['resources'], steps: [] });

    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(extent.resources.length);
  });

  it('a second connection on the same file shares the ledger, and the last close drops it', async () => {
    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    const rows = readWorkCounters()['store.rows.decoded.persistent'];
    const second = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
    try {
      await second.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
      expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(rows);
    } finally {
      await second.close();
    }
    await store.close();
    store = openSqliteFactStore({ directory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });

    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);

    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(rows);
  });

  it('a write naming a key its read covered rewrites nothing of it, so it forgets nothing of it', async () => {
    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    const first = readWorkCounters()['store.rows.decoded.persistent'];
    // Covered at read and held, with no harness pair to settle: the writer keeps the stored rows.
    await store.writeBlobFacts({ rows: { ...everyFormRows().rows, harnessBlobFacts: [], harnessBlobImports: [] }, coveredAtRead: [FIRST_BLOB], settledAtRead: [] });

    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);

    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(first);
  });

  it('a write of a key or tree forgets what was decoded of it', async () => {
    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    await store.readExtent(KEY, ALL_EXTENT_REQUEST);
    await store.writeBlobFacts(uncoveredBlobWrite(everyFormRows().rows));
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));

    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    await store.readExtent(KEY, ALL_EXTENT_REQUEST);

    expect(readWorkCounters()['store.rows.decoded.repeated']).toBe(0);
  });
});

describe('decoded rows are counted against the store they came from', () => {
  /** Rows one {@link sampleBlobRows} bundle holds across every blob-scoped table. */
  const bundleRowCount = Object.values(sampleBlobRows() as unknown as Record<string, readonly unknown[]>)
    .reduce((total, rows) => total + rows.length, 0);

  beforeEach(async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows()));
    __resetWorkCountersForTest();
  });

  afterEach(() => {
    __resetWorkCountersForTest();
  });

  it('a persistent read moves the persistent counter by every row it decoded', async () => {
    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    expect(readWorkCounters()['store.rows.decoded.persistent']).toBe(bundleRowCount);
    expect(readWorkCounters()['hydration.rows.written']).toBe(0);
  });

  it('loading a run database counts hydration, and no fact-store work', async () => {
    const projection = sampleProjection();
    const projectionRowCount = Object.values(projection as unknown as Record<string, readonly unknown[]>)
      .reduce((total, rows) => total + rows.length, 0);
    const database = hydrateEveryTable(projection);
    try {
      // One write for the one hydration transaction, every row of every relation in it.
      expect(readWorkCounters()['hydration.writes']).toBe(1);
      expect(readWorkCounters()['hydration.rows.written']).toBe(projectionRowCount);
      expect(readWorkCounters()['store.writes.persistent']).toBe(0);
      expect(readWorkCounters()['store.rows.written.persistent']).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('a hydration naming no relation writes nothing and counts no write', async () => {
    const database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map() });
    try {
      expect(readWorkCounters()['hydration.writes']).toBe(0);
      expect(readWorkCounters()['hydration.rows.written']).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('a hydration counts only the planned relations\' rows', async () => {
    const projection = sampleProjection();
    const database = hydrateRunDatabase({ rootId: 'root-1', relations: new Map([['blobs', { rows: projection.blobs }]]) });
    try {
      expect(readWorkCounters()['hydration.writes']).toBe(1);
      expect(readWorkCounters()['hydration.rows.written']).toBe(projection.blobs.length);
    } finally {
      await database.close();
    }
  });

  it('a persistent read counts one read against the port read it was', async () => {
    await store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST);
    expect(readWorkCounters()['store.reads.blob']).toBe(1);
    expect(readWorkCounters()['store.reads.extent']).toBe(0);
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    await store.readExtent(KEY, ALL_EXTENT_REQUEST);
    expect(readWorkCounters()['store.reads.blob']).toBe(1);
    expect(readWorkCounters()['store.reads.extent']).toBe(1);
  });

  it('a fact-store write counts one persistent write and every row it wrote, and no hydration', async () => {
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(SECOND_BLOB)));
    expect(readWorkCounters()['store.writes.persistent']).toBe(1);
    expect(readWorkCounters()['store.rows.written.persistent']).toBe(bundleRowCount);

    const extentRows = sampleExtentRows(KEY.rootId);
    const extentRowCount = Object.values(extentRows as unknown as Record<string, readonly unknown[]>)
      .reduce((total, rows) => total + rows.length, 0);
    await store.writeExtent(KEY, extentRows);
    expect(readWorkCounters()['store.writes.persistent']).toBe(2);
    expect(readWorkCounters()['store.rows.written.persistent']).toBe(bundleRowCount + extentRowCount);
    expect(readWorkCounters()['hydration.writes']).toBe(0);
    expect(readWorkCounters()['hydration.rows.written']).toBe(0);
  });

  it('a blob write naming no content key writes nothing and counts nothing', async () => {
    const empty = sampleBlobRows();
    await store.writeBlobFacts(uncoveredBlobWrite({
      ...empty, blobs: [], blobReferences: [], blobSections: [], blobConditions: [], harnessBlobFacts: [], harnessBlobImports: [],
      skillTextFacts: [], skillTextMatches: [],
    }));
    expect(readWorkCounters()['store.writes.persistent']).toBe(0);
    expect(readWorkCounters()['store.rows.written.persistent']).toBe(0);
  });

  it('a read of no content keys counts no read', async () => {
    await store.readBlobFacts([], ALL_BLOB_REQUEST);
    expect(readWorkCounters()['store.reads.blob']).toBe(0);
  });

  it('a read that fails counts no read', async () => {
    dropTable(directory, lastTableOfScope('blob'));
    await expect(store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rejects.toThrow(/no such table/);
    expect(readWorkCounters()['store.reads.blob']).toBe(0);
  });

  it('a read that fails after decoding earlier tables counts no decoded row', async () => {
    // The LAST blob table: every table read before it decodes its rows first.
    dropTable(directory, lastTableOfScope('blob'));
    await expect(store.readBlobFacts([FIRST_BLOB], ALL_BLOB_REQUEST)).rejects.toThrow(/no such table/);
    expect(readWorkCounters()['store.rows.decoded.persistent']).toBe(0);
  });

  it('an extent write that rolls back counts no write and no row written', async () => {
    // The manifest is written after every table's rows, so its absence fails
    // the write after the rows went in, and the transaction rolls them back.
    dropTable(directory, EXTENTS_TABLE);
    await expect(store.writeExtent(KEY, sampleExtentRows(KEY.rootId))).rejects.toThrow(/no such table/);
    expect(readWorkCounters()['store.writes.persistent']).toBe(0);
    expect(readWorkCounters()['store.rows.written.persistent']).toBe(0);
  });

  it('an extent read that fails counts no read and no decoded row', async () => {
    await store.writeExtent(KEY, sampleExtentRows(KEY.rootId));
    __resetWorkCountersForTest();
    dropTable(directory, lastTableOfScope('extent'));
    await expect(store.readExtent(KEY, ALL_EXTENT_REQUEST)).rejects.toThrow(/no such table/);
    expect(readWorkCounters()['store.reads.extent']).toBe(0);
    expect(readWorkCounters()['store.rows.decoded.persistent']).toBe(0);
  });
});

/**
 * How many rows each extent-scoped table holds for one tree, read from the file
 * rather than through the store.
 *
 * 🪤 Row counts, never file size. An eviction that deleted only the `extents`
 * manifest row would make {@link FactStore.readExtent} answer `undefined`
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
function openStoreFile(at: string = directory): DatabaseSync {
  return new DatabaseSync(safePath.join(at, 'projection.db'), { readOnly: true });
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
function openWithRetention(retainedExtentsPerRoot: number): FactStore {
  return openSqliteFactStore({ directory, retainedExtentsPerRoot, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
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
    const evicting = openSqliteFactStore({ directory, retainedExtentsPerRoot: 3, retainedRoots: 2, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
    const first = treeKey('tree-1', 'root-first');
    await evicting.writeExtent(first, extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-1', 'root-second'), extentBundle(BROAD));
    expect(await store.readExtent(first, ALL_EXTENT_REQUEST)).toBeDefined();

    await evicting.writeExtent(treeKey('tree-1', 'root-third'), extentBundle(BROAD));
    await evicting.close();

    expect(await store.readExtent(first, ALL_EXTENT_REQUEST)).toBeUndefined();
    expect(storedRowTotal(first)).toBe(0);
    expect(await store.readExtent(treeKey('tree-1', 'root-second'), ALL_EXTENT_REQUEST)).toBeDefined();
    expect(await store.readExtent(treeKey('tree-1', 'root-third'), ALL_EXTENT_REQUEST)).toBeDefined();
  });

  it('counts a root as recent when ANY of its trees was written recently', async () => {
    // A busy root rewriting its newest tree must not be aged out behind a quiet
    // one, which is the reason retention was per root in the first place.
    const evicting = openSqliteFactStore({ directory, retainedExtentsPerRoot: 3, retainedRoots: 2, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
    await evicting.writeExtent(treeKey('tree-1', 'root-busy'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-1', 'root-quiet'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2', 'root-busy'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-1', 'root-new'), extentBundle(BROAD));
    await evicting.close();

    expect(await store.readExtent(treeKey('tree-1', 'root-quiet'), ALL_EXTENT_REQUEST)).toBeUndefined();
    expect(await store.readExtent(treeKey('tree-2', 'root-busy'), ALL_EXTENT_REQUEST)).toBeDefined();
    expect(await store.readExtent(treeKey('tree-1', 'root-new'), ALL_EXTENT_REQUEST)).toBeDefined();
  });

  it('keeps every tree while the root is under its retention limit', async () => {
    // The negative control. Without it, an eviction that deleted everything it
    // touched would satisfy every other case in this block.
    const evicting = openWithRetention(3);
    await evicting.writeExtent(treeKey('tree-1'), extentBundle(BROAD));
    await evicting.writeExtent(treeKey('tree-2'), extentBundle(BROAD));
    await evicting.close();

    expect(contextsOf(await store.readExtent(treeKey('tree-1'), ALL_EXTENT_REQUEST))).toEqual([FS_CONTEXT, SKILL_CONTEXT, OTHER_SKILL_CONTEXT].sort((l, r) => l.localeCompare(r)));
    expect(await store.readExtent(treeKey('tree-2'), ALL_EXTENT_REQUEST)).toBeDefined();
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
    expect(await store.readExtent(oldest, ALL_EXTENT_REQUEST)).toBeUndefined();
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

    expect(await store.readExtent(other, ALL_EXTENT_REQUEST)).toBeDefined();
    expect(storedRowTotal(other)).toBeGreaterThan(0);
    expect(await store.readExtent(treeKey('tree-1'), ALL_EXTENT_REQUEST)).toBeUndefined();
  });

  it('never evicts the tree it is writing, at a retention of one', async () => {
    // The writer's own protection, and it is structural rather than a special
    // case: the extent being written is by construction the most recently
    // written one, so recency ordering can never select it. That is what makes
    // it safe for `vat build`'s second phase to read what its first phase wrote.
    const evicting = openWithRetention(1);
    for (const hash of ['tree-1', 'tree-2', 'tree-3']) {
      await evicting.writeExtent(treeKey(hash), extentBundle(BROAD));
      expect(await evicting.readExtent(treeKey(hash), ALL_EXTENT_REQUEST)).toBeDefined();
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

    expect(await store.readExtent(treeKey('tree-2'), ALL_EXTENT_REQUEST)).toBeDefined();
    expect(storedRowTotal(treeKey('tree-2'))).toBeGreaterThan(0);
    expect(await store.readExtent(treeKey('tree-1'), ALL_EXTENT_REQUEST)).toBeUndefined();
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
 * A store whose blob budget is small enough to cross in a handful of writes.
 *
 * The production budget is {@link DEFAULT_BLOB_TIER_BUDGET_BYTES}; writing that
 * many bytes here would take minutes and prove the same thing.
 *
 * @param blobTierBudgetBytes - The budget, in `blobRowBytes`
 * @returns An open store on this case's directory
 */
function openWithBlobBudget(blobTierBudgetBytes: number): FactStore {
  return openSqliteFactStore({ directory, blobTierBudgetBytes });
}

/** A harness pair's partition value, as the row type declares it. */
type HarnessId = BlobScopedRows['harnessBlobFacts'][number]['harness'];

/**
 * The logical bytes a bundle's rows measure, computed outside the store: each
 * row encoded as the store binds it, then measured. What the ledger must record
 * for a key whose stored rows are exactly these.
 *
 * @param rows - A blob-scoped bundle
 * @returns Per content key, the `blobRowBytes` of its rows
 */
function measuredBytes(rows: BlobScopedRows): Record<string, number> {
  const bytes: Record<string, number> = {};
  const bundle = rows as unknown as Record<string, readonly Record<string, unknown>[]>;
  for (const spec of allSpecs()) {
    if (spec.scope !== 'blob') continue;
    const columns = projectionColumnTypes(spec);
    for (const row of bundle[spec.key] ?? []) {
      const key = String(row[blobKeyColumn(spec)]);
      bytes[key] = (bytes[key] ?? 0) + blobRowBytes(columns.map(([column, { kind }]) => encodeValue(kind, row[column])));
    }
  }
  return bytes;
}

/**
 * The bytes one key's rows measure.
 *
 * @param rows - A bundle naming the key
 * @param key - The key
 * @returns Its `blobRowBytes`
 */
function keyBytes(rows: BlobScopedRows, key: ContentKey): number {
  return measuredBytes(rows)[key] ?? 0;
}

/**
 * The logical bytes of every key's STORED rows, read from the file rather than
 * through the store: what the ledger must equal for every key.
 *
 * @param at - The store directory
 * @returns Per content key, the `blobRowBytes` of its stored rows
 */
function storedBytes(at: string = directory): Record<string, number> {
  const database = openStoreFile(at);
  try {
    const bytes: Record<string, number> = {};
    for (const spec of allSpecs()) {
      if (spec.scope !== 'blob') continue;
      const keyColumn = blobKeyColumn(spec);
      for (const row of database.prepare(`SELECT * FROM "${spec.name}"`).all() as Record<string, SqliteResultValue>[]) {
        const key = String(row[keyColumn]);
        bytes[key] = (bytes[key] ?? 0) + blobRowBytes(Object.values(row));
      }
    }
    return bytes;
  } finally {
    database.close();
  }
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
function blobRowCounts(key: ContentKey): Record<string, number> {
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
function blobRowTotal(key: ContentKey): number {
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
  /** The bytes one {@link sampleBlobRows} key measures; every seed's key is the same length. */
  const sampleBytes = (): number => keyBytes(sampleBlobRows(contentKey('a')), contentKey('a'));
  /** The bytes one {@link declinedBlobRows} key measures. */
  const declinedBytes = (): number => keyBytes(declinedBlobRows(contentKey('a')), contentKey('a'));

  it('keeps every content key while the store is under its budget', async () => {
    // The negative control, and the reason every assertion below means
    // something: an eviction that reclaimed whatever it touched would satisfy
    // all of them.
    const evicting = openWithBlobBudget(3 * sampleBytes());
    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey('a'))));
    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey('b'))));
    await evicting.close();

    expect(blobRowTotal(contentKey('a'))).toBeGreaterThan(0);
    expect(blobRowTotal(contentKey('b'))).toBeGreaterThan(0);
    expect(trackedBlobKeys()).toBe(2);
  });

  it('reclaims the ROWS of the least recently written key once the budget is passed', async () => {
    // The defect this closes: blob rows carry no tree and no root, so extent
    // eviction could never attribute them, and the tier grew with nothing but
    // the release namespace rotating to bound it. Measured on a 12,602-file
    // adopter tree it is 153,245 of the store's 193,605 rows.
    const evicting = openWithBlobBudget(2 * sampleBytes());
    const oldest = contentKey('a');
    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(oldest)));
    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey('b'))));
    const beforeEviction = blobRowTotal(oldest);

    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey('c'))));
    await evicting.close();

    expect(beforeEviction).toBeGreaterThan(0);
    // Every table, not the total: a prune that cleared all but one would
    // leave a growing tier behind a green sum.
    expect(blobRowCounts(oldest)).toEqual({
      blobs: 0, blob_references: 0, blob_sections: 0, blob_conditions: 0, harness_blob_facts: 0, harness_blob_imports: 0,
      skill_text_facts: 0, skill_text_matches: 0,
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
    const evicting = openWithBlobBudget(sampleBytes());
    const declined = contentKey('d');
    await evicting.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(declined)));
    expect(blobRowCounts(declined)['blobs']).toBe(0);
    expect(blobRowTotal(declined)).toBeGreaterThan(0);

    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey('e'))));
    await evicting.close();

    expect(blobRowTotal(declined)).toBe(0);
  });

  it('never evicts the keys it is writing, at a budget of one byte', async () => {
    // The keys a write records are excluded from eviction by key, whatever their
    // place in the recency order, so a budget smaller than one key keeps them.
    const evicting = openWithBlobBudget(1);
    for (const seed of ['a', 'b', 'c']) {
      await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey(seed))));
      const held = (await evicting.readBlobFacts([contentKey(seed)], ALL_BLOB_REQUEST)).rows;
      expect(held.blobs).toHaveLength(1);
    }
    await evicting.close();
  });

  it('never evicts the keys it is writing when ONE write holds more bytes than the budget', async () => {
    // ⛔ The case the one-key-per-write test above cannot see. Every key of a
    // single write shares its timestamp and holds the newest rowids, but a cut
    // by bytes alone would take the write's own oldest keys — and the coverage
    // check is all-or-nothing, so one missing key would make every run of a tree
    // larger than the budget a full re-derivation that could never hit.
    const evicting = openWithBlobBudget(3 * declinedBytes());
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((seed) => contentKey(seed));
    await evicting.writeBlobFacts(uncoveredBlobWrite({
      blobs: [], blobReferences: [], blobSections: [], harnessBlobFacts: [], harnessBlobImports: [], skillTextFacts: [], skillTextMatches: [],
      blobConditions: keys.flatMap((key) => declinedBlobRows(key).blobConditions),
    }));
    const held = (await evicting.readBlobFacts(keys, ALL_BLOB_REQUEST)).rows;
    await evicting.close();

    expect(new Set(held.blobConditions.map((row) => row.blob))).toEqual(new Set(keys));
  });

  it('trims back to the budget on the next write, and only then', async () => {
    // The oversized write above holds more than the budget until a later write
    // reclaims the surplus — so the bound is still a bound. Room for the next
    // write's key and one declined key: two keys survive it.
    const evicting = openWithBlobBudget(sampleBytes() + declinedBytes());
    await evicting.writeBlobFacts(uncoveredBlobWrite({
      blobs: [], blobReferences: [], blobSections: [], harnessBlobFacts: [], harnessBlobImports: [], skillTextFacts: [], skillTextMatches: [],
      blobConditions: ['a', 'b', 'c', 'd'].flatMap((seed) => declinedBlobRows(contentKey(seed)).blobConditions),
    }));
    expect(trackedBlobKeys()).toBe(4);

    await evicting.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(contentKey('e'))));
    await evicting.close();

    expect(trackedBlobKeys()).toBe(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    'refuses a budget of %s at open, by its code, before touching the directory',
    (budget) => {
      const absent = safePath.join(directory, 'never-created');
      let thrown: unknown;
      try {
        openSqliteFactStore({ directory: absent, blobTierBudgetBytes: budget as number });
      } catch (error) {
        thrown = error;
      }
      expect(isVatError(thrown) ? thrown.code : thrown).toBe(PROJECTION_STORE_BUDGET_INVALID_CODE);
      expect(existsSync(absent)).toBe(false);
    },
  );
});

/** The harness the fixtures' pairs are filed under, and a second one. */
const HARNESS = 'claude-code';
const SECOND_HARNESS = 'second-harness' as HarnessId;

/**
 * A key's sample rows with one extra harness pair and a resized blob row, so
 * a rewrite of it measures differently from the first write.
 *
 * @param key - The key
 * @param harness - The pair's harness
 * @param injectedTokens - The value that tells one pair's rows from another's
 * @returns The rows
 */
function withPair(key: ContentKey, harness: HarnessId, injectedTokens: number): BlobScopedRows {
  const rows = sampleBlobRows(key);
  const [facts] = rows.harnessBlobFacts;
  if (facts === undefined) throw new Error('the sample rows carry a harness pair');
  return {
    ...rows,
    harnessBlobFacts: [...rows.harnessBlobFacts, { ...facts, harness, injectedTokens, paths: ['x'.repeat(injectedTokens)] }],
  };
}

describe('the blob ledger records exactly what each key stores', () => {
  it('records a replaced key at the size of the rows that replaced it, not the rows it had', async () => {
    const key = contentKey('a');
    const small = declinedBlobRows(key);
    const large = sampleBlobRows(key);
    await store.writeBlobFacts(uncoveredBlobWrite(small));
    expect(ledgerBytes()[key]).toBe(keyBytes(small, key));

    await store.writeBlobFacts(uncoveredBlobWrite(large));

    expect(keyBytes(large, key)).not.toBe(keyBytes(small, key));
    expect(ledgerBytes()[key]).toBe(keyBytes(large, key));
  });

  it('keeps a re-stamped key at its recorded bytes', async () => {
    const key = contentKey('a');
    await store.writeBlobFacts(uncoveredBlobWrite(sampleBlobRows(key)));
    const recorded = ledgerBytes()[key];

    await store.writeBlobFacts({
      rows: sampleBlobRows(key),
      coveredAtRead: [key],
      settledAtRead: [{ contentKey: key, harness: HARNESS }],
    });

    expect(recorded).toBe(keyBytes(sampleBlobRows(key), key));
    expect(ledgerBytes()[key]).toBe(recorded);
  });

  it('equals the measure of the stored rows for every key after mixed writes', async () => {
    const [a, b, c] = [contentKey('a'), contentKey('b'), contentKey('c')];
    // Replace: a first write of a and b.
    await store.writeBlobFacts(uncoveredBlobWrite({ ...sampleBlobRows(a), blobConditions: declinedBlobRows(a).blobConditions }));
    await store.writeBlobFacts(uncoveredBlobWrite(withPair(b, SECOND_HARNESS, 3)));
    // Re-stamp of a, adding a second harness's pair it did not hold.
    await store.writeBlobFacts({
      rows: withPair(a, SECOND_HARNESS, 5),
      coveredAtRead: [a],
      settledAtRead: [{ contentKey: a, harness: HARNESS }],
    });
    // A concurrent pair: b covered, its second pair unsettled, so deleted and
    // re-inserted at another size, beside a replaced c.
    await store.writeBlobFacts({
      rows: { ...withPair(b, SECOND_HARNESS, 40), blobs: [...sampleBlobRows(b).blobs, ...sampleBlobRows(c).blobs] },
      coveredAtRead: [b],
      settledAtRead: [{ contentKey: b, harness: HARNESS }],
    });
    // A replace of a again, which takes its second harness's pair with it.
    await store.writeBlobFacts(uncoveredBlobWrite(declinedBlobRows(a)));

    expect(ledgerBytes()).toEqual(storedBytes());
    expect(Object.keys(ledgerBytes()).sort(compareCodeUnits)).toEqual([a, b, c].sort(orderContentKeys));
  });
});

/**
 * One declined-blob row whose size is set by its message, and its bytes by hand.
 *
 * A `blob_conditions` row stores six values: the key (`markdown.sha256.` and 64
 * hex digits, 80 UTF-8 bytes), `code` `BLOB_NOT_TEXT` (13), `ordinal` 0 (a
 * number, 8), `severity` `warning` (7), the message (`messageLength` ASCII
 * bytes) and `line` null (0): 108 bytes plus the message.
 *
 * @param key - The content key
 * @param messageLength - How many bytes the message holds
 * @returns The rows, `blobConditions` alone
 */
function sizedConditionRows(key: ContentKey, messageLength: number): BlobScopedRows {
  return {
    blobs: [], blobReferences: [], blobSections: [], harnessBlobFacts: [], harnessBlobImports: [], skillTextFacts: [], skillTextMatches: [],
    blobConditions: [{ blob: key, code: 'BLOB_NOT_TEXT', ordinal: 0, severity: 'warning', message: 'x'.repeat(messageLength), line: null }],
  } as BlobScopedRows;
}

/** What {@link sizedConditionRows} measures for a message of `messageLength` bytes. */
const conditionRowBytes = (messageLength: number): number => 108 + messageLength;

/** The ledger as the file holds it: each tracked key and its recorded bytes. */
function ledgerBytes(at: string = directory): Record<string, number> {
  const database = openStoreFile(at);
  try {
    const rows = database.prepare('SELECT "contentKey", "bytes" FROM "blob_keys"').all() as { contentKey: string; bytes: number }[];
    return Object.fromEntries(rows.map((row) => [row.contentKey, Number(row.bytes)]));
  } finally {
    database.close();
  }
}

describe('the blob tier is kept within a byte budget', () => {
  it('evicts the oldest keys until the newest fit, by their bytes and not their count', async () => {
    // Five single-key writes of unequal size, oldest first; the budget is the
    // bytes of three of them (B, C, D: 208 + 308 + 208 = 824). Newest first after
    // each write, a key goes once the running sum passes 824:
    //   C: C 308, B 516, A 1024 -> A goes;  E: E 408, D 616, C 924 -> C and B go.
    // A window of three keys would keep C; the byte budget keeps D and E alone.
    const sizes = { a: 400, b: 100, c: 200, d: 100, e: 300 } as const;
    const budget = conditionRowBytes(sizes.b) + conditionRowBytes(sizes.c) + conditionRowBytes(sizes.d);
    const evicting = openSqliteFactStore({ directory, blobTierBudgetBytes: budget });
    for (const [seed, length] of Object.entries(sizes)) {
      await evicting.writeBlobFacts(uncoveredBlobWrite(sizedConditionRows(contentKey(seed), length)));
    }
    await evicting.close();

    expect(Object.keys(sizes).map((seed) => blobRowTotal(contentKey(seed)))).toEqual([0, 0, 0, 1, 1]);
    expect(ledgerBytes()).toEqual({
      [contentKey('d')]: conditionRowBytes(sizes.d),
      [contentKey('e')]: conditionRowBytes(sizes.e),
    });
  });

  it('never evicts a key the write holds, even when its held keys alone exceed the budget', async () => {
    // Two writes of five keys each, every write larger than a budget of three
    // keys' bytes. Each write keeps all five of its own keys; the second evicts
    // every key of the first, since nothing older fits beside it.
    const budget = 3 * conditionRowBytes(100);
    const first = ['f1', 'f2', 'f3', 'f4', 'f5'].map((seed) => contentKey(seed));
    const second = ['s1', 's2', 's3', 's4', 's5'].map((seed) => contentKey(seed));
    const write = (keys: readonly ContentKey[]): ReturnType<typeof uncoveredBlobWrite> => uncoveredBlobWrite({
      ...emptyBlobRows(),
      blobConditions: keys.flatMap((key, index) => sizedConditionRows(key, 100 + 50 * index).blobConditions),
    });
    const evicting = openSqliteFactStore({ directory, blobTierBudgetBytes: budget });
    await evicting.writeBlobFacts(write(first));
    const afterFirst = first.map((key) => blobRowTotal(key));
    await evicting.writeBlobFacts(write(second));
    await evicting.close();

    expect(afterFirst).toEqual([1, 1, 1, 1, 1]);
    expect(first.map((key) => blobRowTotal(key))).toEqual([0, 0, 0, 0, 0]);
    expect(second.map((key) => blobRowTotal(key))).toEqual([1, 1, 1, 1, 1]);
    expect(Object.keys(ledgerBytes()).sort(compareCodeUnits)).toEqual([...second].sort(orderContentKeys));
  });

  it('never evicts a key the write holds when an older key carries a later timestamp', async () => {
    // A store restored from a runner whose clock ran ahead holds `writtenAt`
    // values in this machine's future, so they sort before the keys this write
    // stamps. The write's own keys are protected by key, not by their place in
    // the order: both held keys stay and the future-stamped key goes.
    const budget = 2 * conditionRowBytes(100) + 50;
    const ahead = contentKey('ahead');
    const held = [contentKey('h1'), contentKey('h2')];
    const evicting = openSqliteFactStore({ directory, blobTierBudgetBytes: budget });
    await evicting.writeBlobFacts(uncoveredBlobWrite(sizedConditionRows(ahead, 100)));
    const database = new DatabaseSync(safePath.join(directory, 'projection.db'));
    try {
      database.prepare('UPDATE "blob_keys" SET "writtenAt" = ? WHERE "contentKey" = ?').run('9999-12-31T23:59:59.999Z', ahead);
    } finally {
      database.close();
    }
    await evicting.writeBlobFacts(uncoveredBlobWrite({
      ...emptyBlobRows(),
      blobConditions: held.flatMap((key) => sizedConditionRows(key, 100).blobConditions),
    }));
    await evicting.close();

    expect(held.map((key) => blobRowTotal(key))).toEqual([1, 1]);
    expect(Object.keys(ledgerBytes()).sort(compareCodeUnits)).toEqual([...held].sort(orderContentKeys));
  });
});

/**
 * The SQLite store under the shared writer contract: a fresh store in a new
 * directory under this case's, its ledger and stored rows read from the file.
 */
const openForContract: BlobWriterContractFactory = ({ blobTierBudgetBytes }) => {
  // A fresh directory per open: a case opens a probe store before its own.
  const at = mkdtempSync(safePath.join(directory, 'contract-'));
  return Promise.resolve({
    store: openSqliteFactStore({ directory: at, blobTierBudgetBytes }),
    evict: (key) => evictByHand(at, key),
    ledgerBytes: () => Promise.resolve(ledgerBytes(at)),
    storedBytes: () => Promise.resolve(storedBytes(at)),
  });
};

/**
 * Evict one key as `evictBlobKeysPastBudget` does: every blob-scoped table's
 * rows and the ledger row, in one transaction.
 *
 * @param at - The store directory
 * @param key - The key
 * @returns Once done
 */
function evictByHand(at: string, key: ContentKey): Promise<void> {
  const database = new DatabaseSync(safePath.join(at, 'projection.db'));
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const spec of Object.values(PROJECTION_TABLES)) {
      if (spec.scope !== 'blob') continue;
      database.prepare(`DELETE FROM "${spec.name}" WHERE "${String(spec.primaryKey[0])}" = ?`).run(key);
    }
    database.prepare('DELETE FROM "blob_keys" WHERE "contentKey" = ?').run(key);
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  return Promise.resolve();
}

describe('the blob writer contract', () => {
  for (const contractCase of BLOB_WRITER_CONTRACT) {
    it(contractCase.name, async () => {
      await expect(contractCase.run(openForContract), contractCase.mutant).resolves.toBeUndefined();
    });
  }
});

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

describe('a lens write is not hydration', () => {
  afterEach(() => {
    __resetWorkCountersForTest();
  });

  it('writeDerived moves neither hydration counter', async () => {
    const database = hydrateEveryTable(sampleProjection());
    try {
      __resetWorkCountersForTest();
      await database.writeDerived({
        edges: [{ src: 'res-1', refOrdinal: 0, contextId: 'lens-a', kind: 'local_file', origin: 'authored' }],
      });
      expect(database.query('SELECT COUNT(*) AS n FROM edges'), 'the write landed nothing').toEqual([{ n: 1 }]);
      expect(readWorkCounters()['hydration.writes']).toBe(0);
      expect(readWorkCounters()['hydration.rows.written']).toBe(0);
    } finally {
      await database.close();
    }
  });
});

describe('an open that fails after the connection opened releases it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the run database when loading the projection throws', () => {
    const closes = vi.spyOn(DatabaseSync.prototype, 'close');
    const [blob] = sampleProjection().blobs;
    // A string in an integer column: the load throws after the database opened.
    const unloadable = { ...sampleProjection(), blobs: [{ ...blob, bytes: 'not a number' }] } as unknown as Projection;

    expect(() => hydrateEveryTable(unloadable)).toThrow();
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it('closes the fact store when setting up its file throws', () => {
    const corrupt = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-corrupt-'));
    try {
      // Not a database: opening succeeds, and the first pragma fails.
      writeFileSync(safePath.join(corrupt, 'projection.db'), Buffer.alloc(4096, 0x5a));
      const closes = vi.spyOn(DatabaseSync.prototype, 'close');

      expect(() => openSqliteFactStore({ directory: corrupt, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES })).toThrow(/not a database/u);
      expect(closes).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(corrupt, { recursive: true, force: true });
    }
  });
});
