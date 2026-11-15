/**
 * `expectAbsenceCause` — a structured signature matched against a projection's
 * rows, never a string prefix, and a throw (never a quiet `false`) when no row
 * carries the cause.
 */

import { describe, expect, it } from 'vitest';

import {
  absenceObservations,
  expectAbsenceCause,
  matchesAbsenceCause,
  type AbsenceObservation,
  type AbsenceRows,
} from '../src/testing.js';

const PACKAGE_EXTENT = 'ctx-package';
const FILESYSTEM_EXTENT = 'ctx-filesystem';
const NOT_EXPORTED = 'PACKAGE_SUBPATH_NOT_EXPORTED';

/** One row of each table an absence cause is observed in, and the contexts naming two extents. */
function rows(): AbsenceRows {
  return {
    blobConditions: [{ code: 'BLOB_UNREADABLE' }],
    resourceRealizations: [{ contentState: 'keyed' }, { contentState: 'oversize' }],
    realizationConditions: [
      { code: NOT_EXPORTED, extentId: PACKAGE_EXTENT, resourceId: 'res-package' },
      { code: NOT_EXPORTED, extentId: PACKAGE_EXTENT, resourceId: null },
      { code: 'EXTENT_DIRECTORY_UNLISTABLE', extentId: FILESYSTEM_EXTENT, resourceId: 'res-dir' },
      { code: 'ORPHAN', extentId: 'ctx-nowhere', resourceId: null },
    ],
    resolutionContexts: [
      { contextId: PACKAGE_EXTENT, kind: 'package' },
      { contextId: FILESYSTEM_EXTENT, kind: 'filesystem' },
    ],
  };
}

describe('absenceObservations', () => {
  it('reads one observation per row, each condition carrying its extent kind and whether it names a resource', () => {
    expect(absenceObservations(rows())).toEqual([
      { table: 'blob_conditions', code: 'BLOB_UNREADABLE' },
      { table: 'resource_realizations', contentState: 'keyed' },
      { table: 'resource_realizations', contentState: 'oversize' },
      { table: 'realization_conditions', code: NOT_EXPORTED, extentId: PACKAGE_EXTENT, extentKind: 'package', resourceIdPresent: true },
      { table: 'realization_conditions', code: NOT_EXPORTED, extentId: PACKAGE_EXTENT, extentKind: 'package', resourceIdPresent: false },
      { table: 'realization_conditions', code: 'EXTENT_DIRECTORY_UNLISTABLE', extentId: FILESYSTEM_EXTENT, extentKind: 'filesystem', resourceIdPresent: true },
      { table: 'realization_conditions', code: 'ORPHAN', extentId: 'ctx-nowhere', extentKind: null, resourceIdPresent: false },
    ]);
  });
});

describe('matchesAbsenceCause', () => {
  const observed = absenceObservations(rows());
  const at = (index: number): AbsenceObservation => {
    const observation = observed[index];
    if (observation === undefined) throw new Error(`no observation ${String(index)}`);
    return observation;
  };
  const blob = at(0);
  const keyed = at(1);
  const oversize = at(2);
  const packageLevel = at(3);
  const subpathLevel = at(4);
  const unlistable = at(5);
  const orphan = at(6);

  it('matches a code signature in either condition table, and a state only on a realization', () => {
    expect(matchesAbsenceCause(blob, { code: 'BLOB_UNREADABLE' })).toBe(true);
    expect(matchesAbsenceCause(unlistable, { code: 'EXTENT_DIRECTORY_UNLISTABLE' })).toBe(true);
    expect(matchesAbsenceCause(oversize, { contentState: 'oversize' })).toBe(true);
    expect(matchesAbsenceCause(keyed, { contentState: 'oversize' })).toBe(false);
    expect(matchesAbsenceCause(blob, { contentState: 'oversize' })).toBe(false);
    expect(matchesAbsenceCause(oversize, { code: 'BLOB_UNREADABLE' })).toBe(false);
  });

  it('holds a kind-qualified signature to the row\'s own extent kind, and an unknown kind matches none', () => {
    expect(matchesAbsenceCause(unlistable, { code: 'EXTENT_DIRECTORY_UNLISTABLE', extentKind: 'filesystem' })).toBe(true);
    expect(matchesAbsenceCause(unlistable, { code: 'EXTENT_DIRECTORY_UNLISTABLE', extentKind: 'git' })).toBe(false);
    expect(matchesAbsenceCause(orphan, { code: 'ORPHAN', extentKind: 'package' })).toBe(false);
    expect(matchesAbsenceCause(blob, { code: 'BLOB_UNREADABLE', extentKind: 'filesystem' })).toBe(false);
  });

  it('reads resourceIdPresent as the row\'s shape alone, whatever the extent kind', () => {
    expect(matchesAbsenceCause(unlistable, { code: 'EXTENT_DIRECTORY_UNLISTABLE', resourceIdPresent: true })).toBe(true);
    expect(matchesAbsenceCause(orphan, { code: 'ORPHAN', resourceIdPresent: false })).toBe(true);
    expect(matchesAbsenceCause(orphan, { code: 'ORPHAN', resourceIdPresent: true })).toBe(false);
  });

  it('tells a package-level row from a subpath-level one by shape', () => {
    const packageLevelSignature = { code: NOT_EXPORTED, extentKind: 'package', resourceIdPresent: true };
    expect(matchesAbsenceCause(packageLevel, packageLevelSignature)).toBe(true);
    expect(matchesAbsenceCause(subpathLevel, packageLevelSignature)).toBe(false);
  });
});

describe('expectAbsenceCause', () => {
  it('returns the rows carrying the cause, so the caller can assert on them too', () => {
    expect(expectAbsenceCause(rows(), { code: NOT_EXPORTED, extentKind: 'package', resourceIdPresent: true })).toEqual([
      { table: 'realization_conditions', code: NOT_EXPORTED, extentId: PACKAGE_EXTENT, extentKind: 'package', resourceIdPresent: true },
    ]);
  });

  it('throws, naming the signature, when no row carries the cause', () => {
    expect(() => expectAbsenceCause(rows(), { contentState: 'unreadable' })).toThrow(/unreadable/);
    expect(() => expectAbsenceCause(rows(), { code: 'EXTENT_DIRECTORY_UNLISTABLE', extentKind: 'package' })).toThrow(/no row/);
  });
});
