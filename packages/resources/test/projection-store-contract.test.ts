/**
 * The storage seam's own contract: the scope split, the projection split, the
 * shape digest, and identifier quoting.
 *
 * No backend is involved. What is being pinned here is that the *interface*
 * derives everything from the registry — so a thirteenth table joins the right
 * bundle, and a schema edit moves the digest, without anyone editing a second
 * list.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Projection } from '../src/projection/projection.js';
import { quoteIdentifier } from '../src/projection/sql-identifiers.js';
import { projectionShapeDigest, splitProjectionByScope } from '../src/projection/store.js';
import { PROJECTION_TABLES, type ProjectionTableName } from '../src/projection/table-registry.js';
import { BlobRowSchema } from '../src/schemas/projection-blobs.js';

/** The specifier both the digest harness and the no-constant test reach for. */
const TABLE_REGISTRY_MODULE = '../src/projection/table-registry.js';

/**
 * Every table that declares a `contextColumn`, and the column it declares.
 *
 * Transcribed rather than derived, because this list is the *decision*: it says
 * which tables a stored extent can be cut along, and therefore what a write
 * replaces and what a read is allowed to take. Deriving it from the registry
 * would restate the registry and assert nothing.
 */
const EXPECTED_CONTEXT_COLUMNS: Partial<Record<ProjectionTableName, string>> = {
  resourceRealizations: 'extentId',
  resourceExtents: 'extentId',
  realizationConditions: 'extentId',
  resolutionContexts: 'contextId',
  zoneProvenance: 'contextId',
};

/** An empty projection — twelve tables, no rows. */
function emptyProjection(): Projection {
  const tables: Record<string, readonly unknown[]> = {};
  for (const spec of Object.values(PROJECTION_TABLES)) {
    tables[spec.key] = [];
  }
  return tables as unknown as Projection;
}

/**
 * The registry with one table's `contextColumn` rewritten, or removed.
 *
 * Every other fact — schema object, primary key, scope, SQL name, declaration
 * order — is the real registry's, so a digest that moves under this moved
 * because of the context column and nothing else.
 *
 * @param table - Which table to perturb
 * @param contextColumn - The column to declare, or `undefined` to declare none
 * @returns A registry-shaped object for the mock to serve
 */
function registryWithContextColumn(
  table: ProjectionTableName,
  contextColumn: string | undefined,
): Record<string, unknown> {
  const spec: Record<string, unknown> = { ...PROJECTION_TABLES[table] };
  if (contextColumn === undefined) {
    // The absent key, not a key holding `undefined` — `exactOptionalPropertyTypes`
    // makes those different values, and "this table has no context column" is
    // the absence.
    delete spec['contextColumn'];
  } else {
    spec['contextColumn'] = contextColumn;
  }
  return { ...PROJECTION_TABLES, [table]: spec };
}

/**
 * Take the digest of a hypothetical registry.
 *
 * The digest memoizes per module instance and reads the registry through an
 * import, so the only way to ask "what would this registry hash to" is to reset
 * the module graph, serve the perturbed registry, and re-import `store.js`. The
 * control case below hands back the *real* registry through the same machinery,
 * which is what makes a difference attributable to the perturbation rather than
 * to the mocking.
 *
 * @param tables - The registry the fresh `store.js` should read
 * @returns That registry's shape digest
 */
async function digestUnderRegistry(tables: Record<string, unknown>): Promise<string> {
  vi.resetModules();
  vi.doMock(TABLE_REGISTRY_MODULE, async () => ({
    // Everything else the module exports passes straight through: only the
    // registry itself is being asked a hypothetical question.
    ...(await vi.importActual<Record<string, unknown>>(TABLE_REGISTRY_MODULE)),
    PROJECTION_TABLES: tables,
  }));
  try {
    const { projectionShapeDigest: digestOf } = await import('../src/projection/store.js');
    return digestOf();
  } finally {
    vi.doUnmock(TABLE_REGISTRY_MODULE);
    vi.resetModules();
  }
}

describe('table scopes', () => {
  it('declares a scope for all twelve tables', () => {
    for (const spec of Object.values(PROJECTION_TABLES)) {
      expect(['blob', 'extent'], spec.name).toContain(spec.scope);
    }
  });

  it('scopes exactly the blob-keyed tables to blob', () => {
    const blobScoped = Object.values(PROJECTION_TABLES)
      .filter((spec) => spec.scope === 'blob')
      .map((spec) => spec.key);
    expect(blobScoped).toEqual(['blobs', 'blobReferences', 'blobSections', 'blobConditions']);
  });

  it('scopes every table that names an extent or a root to extent', () => {
    const extentScoped = Object.values(PROJECTION_TABLES)
      .filter((spec) => spec.scope === 'extent')
      .map((spec) => spec.key);
    expect(extentScoped).toEqual([
      'roots', 'resources', 'resourceRealizations', 'resourceExtents',
      'resourceTags', 'realizationConditions', 'resolutionContexts', 'zoneProvenance',
    ]);
  });
});

describe('context columns', () => {
  it('declares one on exactly the five divisible tables, and the expected column on each', () => {
    // What makes a stored extent divisible. A table that quietly gained a
    // context column would start being *replaced* per-context by a write that
    // used to merge it by primary key; one that lost its column would have its
    // whole key range replaced by the narrowest run that touched the tree.
    const declared = Object.fromEntries(
      Object.values(PROJECTION_TABLES)
        .filter((spec) => spec.contextColumn !== undefined)
        .map((spec) => [spec.key, spec.contextColumn]),
    );

    expect(declared).toEqual(EXPECTED_CONTEXT_COLUMNS);
  });

  it('leaves exactly roots, resources and resourceTags without one', () => {
    // These three are facts about the tree or about an identity, not about one
    // extent's view of it, so they are merged by primary key and reconstructed
    // by reachability on read (see `store-hydration.ts`). A fourth name
    // appearing here means some table lost the partitioning a write depends on.
    const contextLess = Object.values(PROJECTION_TABLES)
      .filter((spec) => spec.scope === 'extent' && spec.contextColumn === undefined)
      .map((spec) => spec.key);

    expect(contextLess).toEqual(['roots', 'resources', 'resourceTags']);
  });
});

describe('splitProjectionByScope', () => {
  it('sends every table to exactly one half', () => {
    const { blobs, extent } = splitProjectionByScope(emptyProjection());
    const blobKeys = Object.keys(blobs);
    const extentKeys = Object.keys(extent);

    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect([...blobKeys, ...extentKeys].sort(byName)).toEqual(Object.keys(PROJECTION_TABLES).sort(byName));
    expect(blobKeys.filter((key) => extentKeys.includes(key))).toEqual([]);
  });

  it('carries the rows through rather than copying them', () => {
    const projection = emptyProjection();
    const { blobs, extent } = splitProjectionByScope(projection);

    expect(blobs.blobs).toBe(projection.blobs);
    expect(extent.roots).toBe(projection.roots);
  });
});

describe('projectionShapeDigest', () => {
  it('is twelve lowercase hex digits', () => {
    expect(projectionShapeDigest()).toMatch(/^[\da-f]{12}$/u);
  });

  it('is stable within a process, so a store path does not move under it', () => {
    expect(projectionShapeDigest()).toBe(projectionShapeDigest());
  });

  it('is derived rather than declared — no constant to bump', async () => {
    // The guard this replaces was a hand-bumped `PROJECTION_SCHEMA_VERSION`.
    // If one comes back, it will be findable by name; the digest never is.
    const source = await import('../src/projection/store.js');
    expect(Object.keys(source)).not.toContain('PROJECTION_SCHEMA_VERSION');
  });

  it('is unmoved when the real registry is served back through the mock, so the harness itself proves nothing', () => {
    // The control for the two cases below. Resetting the module graph and
    // re-importing `store.js` is machinery, and machinery that moved the digest
    // on its own would make every "it moves" assertion below vacuous.
    return expect(digestUnderRegistry({ ...PROJECTION_TABLES })).resolves.toBe(projectionShapeDigest());
  });

  it('moves when a row schema gains a column, which is the ONLY thing making a new column safe to add', async () => {
    // This repository prohibits hand-maintained version constants, so nothing
    // gets bumped when a column is added — the store simply has to land in a
    // different directory, or a build written before the column is read back by
    // a build that expects it. The three decode columns
    // (`encoding`/`encodingSource`/`replacementCharacters`) are the live case:
    // the digest under a `blobs` schema WITHOUT them must differ from the digest
    // this build actually uses.
    const withoutDecodeColumns = await digestUnderRegistry({
      ...PROJECTION_TABLES,
      blobs: {
        ...PROJECTION_TABLES.blobs,
        schema: BlobRowSchema.omit({
          encoding: true,
          encodingSource: true,
          replacementCharacters: true,
        }),
      },
    });

    expect(withoutDecodeColumns).not.toBe(projectionShapeDigest());
  });

  it('moves when a table declares a DIFFERENT contextColumn', async () => {
    // The column decides what a write replaces. Rows already filed under one
    // partitioning survive a write that partitions differently, so a store
    // written before the change and read after it holds rows this build would
    // never have kept — and nothing in the rows themselves says so. Sharing a
    // directory across the change is the failure; a different digit in the path
    // is the whole prevention.
    const moved = await digestUnderRegistry(registryWithContextColumn('resourceRealizations', 'resourceId'));

    expect(moved).not.toBe(projectionShapeDigest());
  });

  it('moves when a table stops declaring a contextColumn at all', async () => {
    // The other direction, and not the same edit: dropping the column turns a
    // per-context replace into a whole-key-range replace, which is how the
    // narrow run silently deletes the broad run's closure extents.
    const dropped = await digestUnderRegistry(registryWithContextColumn('resourceRealizations', undefined));

    expect(dropped).not.toBe(projectionShapeDigest());
  });
});

describe('quoteIdentifier', () => {
  it.each([
    ['blob_sections', '"blob_sections"'],
    ['we"ird', '"we""ird"'],
    ['"; DROP TABLE blobs; --', '"""; DROP TABLE blobs; --"'],
    ['', '""'],
  ])('quotes %j as %j', (input, expected) => {
    expect(quoteIdentifier(input)).toBe(expected);
  });
});
