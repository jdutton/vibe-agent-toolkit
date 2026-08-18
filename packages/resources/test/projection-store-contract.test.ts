/**
 * The storage seam's own contract: the scope split, the projection split, the
 * shape digest, and identifier quoting.
 *
 * No backend is involved. What is being pinned here is that the *interface*
 * derives everything from the registry — so a thirteenth table joins the right
 * bundle, and a schema edit moves the digest, without anyone editing a second
 * list.
 */

import { describe, expect, it } from 'vitest';

import type { Projection } from '../src/projection/projection.js';
import { quoteIdentifier } from '../src/projection/sql-identifiers.js';
import { projectionShapeDigest, splitProjectionByScope } from '../src/projection/store.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';

/** An empty projection — twelve tables, no rows. */
function emptyProjection(): Projection {
  const tables: Record<string, readonly unknown[]> = {};
  for (const spec of Object.values(PROJECTION_TABLES)) {
    tables[spec.key] = [];
  }
  return tables as unknown as Projection;
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
