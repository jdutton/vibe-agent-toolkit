import { describe, expect, it } from 'vitest';

import { __internal } from '../src/projection/resource-population.js';
import { CONDITION_WITHOUT_REFERENCE, type RealizationConditionRow } from '../src/schemas/projection-resources.js';

const { canonicalConditions, CONDITION_ORDER } = __internal;

/** One condition row, every column stated. */
function condition(overrides: Partial<RealizationConditionRow>): RealizationConditionRow {
  return {
    extentId: 'tree:.',
    path: 'docs/a.md',
    code: 'EXTENT_SYMLINK_NOT_REALIZED',
    severity: 'info',
    message: 'm',
    resourceId: null,
    ...CONDITION_WITHOUT_REFERENCE,
    ...overrides,
  };
}

/**
 * Two valid, distinct values for every column, so a pair of rows can be made to
 * differ in exactly one of them — whichever {@link CONDITION_ORDER} puts last.
 */
const TWO_VALUES: { readonly [Column in keyof RealizationConditionRow]: readonly [RealizationConditionRow[Column], RealizationConditionRow[Column]] } = {
  extentId: ['tree:.', 'tree:docs'],
  path: ['docs/a.md', 'docs/b.md'],
  code: ['EXTENT_SYMLINK_NOT_REALIZED', 'REALIZATION_PATH_COLLISION'],
  severity: ['info', 'warning'],
  message: ['m', 'n'],
  resourceId: [null, 'r-1'],
  sourcePath: [null, 'docs/x.md'],
  sourceLine: [null, 3],
  sourceRef: [null, './x.md'],
  targetExists: [null, true],
  matchedPattern: [null, '**/*.md'],
  matchedPayload: [null, { rule: 1 }],
  targetFaultClass: [null, 'refused'],
};

/** The column a comparator reaches only after every other column tied. */
const LAST_COLUMN = CONDITION_ORDER.at(-1) as keyof RealizationConditionRow;

const UNLISTABLE = condition({ code: 'EXTENT_DIRECTORY_UNLISTABLE', path: 'locked', severity: 'warning' });
const SYMLINK_B = condition({ path: 'docs/b.md' });
const SYMLINK_A = condition({ path: 'docs/a.md' });
// Equal on every column but the LAST in CONDITION_ORDER: only a comparator that
// reads the whole row tells them apart, so one that stops a column early leaves
// them in whichever order arrived.
const TIE_LOW = condition({ [LAST_COLUMN]: TWO_VALUES[LAST_COLUMN][0] });
const TIE_HIGH = condition({ [LAST_COLUMN]: TWO_VALUES[LAST_COLUMN][1] });

/** Two references to one unresolved target from different files: the realistic tie on code and path. */
const UNRESOLVED_FROM = (sourcePath: string): RealizationConditionRow => condition({
  code: 'CLOSURE_REFERENCE_UNRESOLVED',
  path: 'docs/gone.md',
  severity: 'warning',
  sourcePath,
  sourceLine: 1,
  sourceRef: './gone.md',
});

describe('canonicalConditions — the one order a population\'s conditions leave in, derived or stored', () => {
  it('covers every column of the row, so no column can be skipped by the order', () => {
    // As sets, plus a length check, so a repeated column cannot stand in for a missing one.
    expect(new Set(CONDITION_ORDER)).toEqual(new Set(Object.keys(TWO_VALUES)));
    expect(CONDITION_ORDER).toHaveLength(Object.keys(TWO_VALUES).length);
  });

  it('sorts conditions by code, then path', () => {
    expect(canonicalConditions([SYMLINK_B, UNLISTABLE, SYMLINK_A])).toEqual([UNLISTABLE, SYMLINK_A, SYMLINK_B]);
  });

  it('is TOTAL over the row: rows equal on every column but the last still come out in one order', () => {
    const forward = canonicalConditions([TIE_LOW, TIE_HIGH, UNLISTABLE]);
    const reversed = canonicalConditions([UNLISTABLE, TIE_HIGH, TIE_LOW]);
    expect(reversed).toEqual(forward);
    expect(forward[0]).toEqual(UNLISTABLE);
  });

  it('orders two references to one unresolved target by the file that holds each', () => {
    const fromB = UNRESOLVED_FROM('docs/b.md');
    const fromA = UNRESOLVED_FROM('docs/a.md');
    expect(canonicalConditions([fromB, fromA])).toEqual([fromA, fromB]);
    expect(canonicalConditions([fromA, fromB])).toEqual([fromA, fromB]);
  });

  it('does not reorder its input in place', () => {
    const conditions = [SYMLINK_B, SYMLINK_A];
    canonicalConditions(conditions);
    expect(conditions).toEqual([SYMLINK_B, SYMLINK_A]);
  });
});
