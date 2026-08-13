import { describe, expect, it } from 'vitest';

import { ProjectionBuilder } from '../src/projection/projection.js';
import type { ResourceRealizationRow } from '../src/schemas/projection-resources.js';
import type { ZoneProvenanceRow } from '../src/schemas/projection-zones.js';

// A non-/tmp sentinel: nothing here touches disk, and a `/tmp/...` literal is a
// `sonarjs/publicly-writable-directories` error even when it never does.
const ROOT = '/vat-corpus/x';
const EXTENT_ID = 'ctx-git';
const OTHER_EXTENT_ID = 'ctx-filesystem';
const OCCUPIED_PATH = 'docs/a.md';
const COLLISION_CODE = 'REALIZATION_PATH_COLLISION';
const RES_FIRST = 'res-first';
const RES_SECOND = 'res-second';
const RES_ONE = 'res-one';
const CONTRIBUTOR_ID = 'builtin:git';

function newBuilder(): ProjectionBuilder {
  return new ProjectionBuilder(ROOT);
}

function realization(resourceId: string, path: string): ResourceRealizationRow {
  return {
    resourceId, extentId: EXTENT_ID, path,
    pathLower: path.toLowerCase(), basenameLower: 'a.md', dir: 'docs', depth: 2, ext: '.md',
    // An existing, non-directory path with a null key: `deferred` is the state
    // that describes it, and the only one the superRefine admits alongside a
    // null key for a path that genuinely has bytes.
    contentKey: null, contentState: 'deferred',
    mtime: null, exists: true, isDirectory: false,
    gitignored: false, isSymlink: false, symlinkResolves: null,
  };
}

function provenance(digest: string): ZoneProvenanceRow {
  return { contextId: EXTENT_ID, contributorId: CONTRIBUTOR_ID, parameterSet: null, extentDigest: digest };
}

describe('ProjectionBuilder', () => {
  it('starts empty', () => {
    expect(newBuilder().build().resources).toEqual([]);
  });

  it('keeps the first realization at an occupied (extentId, path)', () => {
    const builder = newBuilder();
    builder.addRealization(realization(RES_FIRST, OCCUPIED_PATH));
    builder.addRealization(realization(RES_SECOND, OCCUPIED_PATH));

    const projection = builder.build();
    expect(projection.resourceRealizations).toHaveLength(1);
    expect(projection.resourceRealizations[0]?.resourceId).toBe(RES_FIRST);
  });

  it('records the loser as a condition rather than discarding it', () => {
    const builder = newBuilder();
    builder.addRealization(realization(RES_FIRST, OCCUPIED_PATH));
    builder.addRealization(realization(RES_SECOND, OCCUPIED_PATH));

    const conditions = builder.build().realizationConditions;
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.code).toBe(COLLISION_CODE);
    expect(conditions[0]?.resourceId).toBe(RES_SECOND);
    expect(conditions[0]?.path).toBe(OCCUPIED_PATH);
    // Both identities are nameable from the row alone — that is what makes it a
    // replacement for the DuplicateResourceIdError it inherits.
    expect(conditions[0]?.message).toContain(RES_FIRST);
    expect(conditions[0]?.message).toContain(RES_SECOND);
  });

  it('treats an identical re-contribution as a no-op, not a collision', () => {
    // The closure stratum runs to a fixpoint, so a contributor re-emits its own
    // rows every iteration. Counting that as a collision would grow the
    // condition table without bound and the fixpoint would never be reached.
    const builder = newBuilder();
    expect(builder.addRealization(realization(RES_FIRST, OCCUPIED_PATH))).toBe(true);
    expect(builder.addRealization(realization(RES_FIRST, OCCUPIED_PATH))).toBe(false);

    const projection = builder.build();
    expect(projection.resourceRealizations).toHaveLength(1);
    expect(projection.realizationConditions).toEqual([]);
  });

  it('lets the same path exist in two different extents', () => {
    const builder = newBuilder();
    builder.addRealization(realization(RES_ONE, OCCUPIED_PATH));
    builder.addRealization({ ...realization(RES_ONE, OCCUPIED_PATH), extentId: OTHER_EXTENT_ID });

    expect(builder.build().resourceRealizations).toHaveLength(2);
    expect(builder.build().realizationConditions).toEqual([]);
  });

  it('de-duplicates identical extent memberships', () => {
    const builder = newBuilder();
    builder.addExtentMembership({ resourceId: RES_ONE, extentId: EXTENT_ID });
    builder.addExtentMembership({ resourceId: RES_ONE, extentId: EXTENT_ID });
    expect(builder.build().resourceExtents).toHaveLength(1);
  });

  it('refreshes a contributor provenance row instead of keeping a stale digest', () => {
    // The digest that describes a closure contributor's extent is the one from
    // its LAST iteration; keeping the first would make §7.4's convergence oracle
    // compare the wrong extents.
    const builder = newBuilder();
    builder.addProvenance(provenance('digest-iteration-1'));
    builder.addProvenance(provenance('digest-iteration-2'));

    const rows = builder.build().zoneProvenance;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.extentDigest).toBe('digest-iteration-2');
  });

  it('hands a contributor a base with no mutators on it', () => {
    const base = newBuilder().base();
    expect('addRealization' in base).toBe(false);
    expect(Array.isArray(base.resourceRealizations)).toBe(true);
  });

  it('gives the base a live view of rows contributed after it was handed out', () => {
    // A later stratum must see what an earlier one contributed through the same
    // object; a snapshot taken at base() time could not.
    const builder = newBuilder();
    const base = builder.base();
    expect(base.resourceRealizations).toHaveLength(0);

    builder.addRealization(realization(RES_FIRST, OCCUPIED_PATH));
    expect(base.resourceRealizations).toHaveLength(1);
  });

  it('leaves the builder usable after build(), and does not leak the built rows', () => {
    const builder = newBuilder();
    builder.addRealization(realization(RES_FIRST, OCCUPIED_PATH));
    const first = builder.build();

    builder.addExtentMembership({ resourceId: RES_ONE, extentId: EXTENT_ID });
    expect(first.resourceExtents).toHaveLength(0);
    expect(builder.build().resourceExtents).toHaveLength(1);
    expect(Object.isFrozen(first.resourceRealizations)).toBe(true);
  });
});
