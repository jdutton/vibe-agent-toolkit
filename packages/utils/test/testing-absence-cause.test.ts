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
const SAMPLE_CODE = 'SAMPLE_CONDITION_CODE';

/** One row of each table an absence cause is observed in, and the contexts naming two extents. */
function rows(): AbsenceRows {
  return {
    blobConditions: [{ code: 'BLOB_UNREADABLE' }],
    resourceRealizations: [{ contentState: 'keyed' }, { contentState: 'oversize' }],
    realizationConditions: [
      { code: SAMPLE_CODE, extentId: PACKAGE_EXTENT },
      { code: 'EXTENT_DIRECTORY_UNLISTABLE', extentId: FILESYSTEM_EXTENT },
      { code: 'ORPHAN', extentId: 'ctx-nowhere' },
    ],
    resolutionContexts: [
      { contextId: PACKAGE_EXTENT, kind: 'package' },
      { contextId: FILESYSTEM_EXTENT, kind: 'filesystem' },
    ],
  };
}

describe('absenceObservations', () => {
  it('reads one observation per row, each condition carrying its extent kind', () => {
    expect(absenceObservations(rows())).toEqual([
      { table: 'blob_conditions', code: 'BLOB_UNREADABLE' },
      { table: 'resource_realizations', contentState: 'keyed' },
      { table: 'resource_realizations', contentState: 'oversize' },
      { table: 'realization_conditions', code: SAMPLE_CODE, extentId: PACKAGE_EXTENT, extentKind: 'package' },
      { table: 'realization_conditions', code: 'EXTENT_DIRECTORY_UNLISTABLE', extentId: FILESYSTEM_EXTENT, extentKind: 'filesystem' },
      { table: 'realization_conditions', code: 'ORPHAN', extentId: 'ctx-nowhere', extentKind: null },
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
  const unlistable = at(4);
  const orphan = at(5);

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
});

describe('expectAbsenceCause', () => {
  it('returns the rows carrying the cause, so the caller can assert on them too', () => {
    expect(expectAbsenceCause(rows(), { code: SAMPLE_CODE, extentKind: 'package' })).toEqual([
      { table: 'realization_conditions', code: SAMPLE_CODE, extentId: PACKAGE_EXTENT, extentKind: 'package' },
    ]);
  });

  it('throws, naming the signature, when no row carries the cause', () => {
    expect(() => expectAbsenceCause(rows(), { contentState: 'unreadable' })).toThrow(/unreadable/);
    expect(() => expectAbsenceCause(rows(), { code: 'EXTENT_DIRECTORY_UNLISTABLE', extentKind: 'package' })).toThrow(/no row/);
  });
});
