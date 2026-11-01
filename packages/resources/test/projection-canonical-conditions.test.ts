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
 * Two valid, distinct values for every column, LOWER first, so a pair of rows
 * can be made to differ in exactly one of them.
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

const UNLISTABLE = condition({ code: 'EXTENT_DIRECTORY_UNLISTABLE', path: 'locked', severity: 'warning' });
const SYMLINK_B = condition({ path: 'docs/b.md' });
const SYMLINK_A = condition({ path: 'docs/a.md' });

/**
 * Two rows equal on every column but `column`, lower first.
 *
 * @param column - The one column they differ in
 * @returns The pair, in the order the comparator must put them
 */
function differingOnlyIn(column: keyof RealizationConditionRow): [RealizationConditionRow, RealizationConditionRow] {
  const [low, high] = TWO_VALUES[column];
  return [condition({ [column]: low }), condition({ [column]: high })];
}

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

  // Every column, not only the last: a comparator that skips ANY column ties two
  // rows that differ only there, and a stable sort then hands them back in
  // whichever order arrived — so forward and reversed input disagree.
  it.each(CONDITION_ORDER)('is TOTAL over the row: two rows differing only in %s come out in one order', (column) => {
    const [low, high] = differingOnlyIn(column);
    expect(canonicalConditions([low, high])).toEqual([low, high]);
    expect(canonicalConditions([high, low])).toEqual([low, high]);
  });

  // `TWO_VALUES` puts null low for these, so only the null rule decides there;
  // two NON-null values reach the comparison for booleans and objects.
  it.each([
    { column: 'targetExists', low: false, high: true },
    { column: 'matchedPayload', low: { rule: 1 }, high: { rule: 2 } },
  ] as const)('orders two non-null $column values', ({ column, low, high }) => {
    const [lowRow, highRow] = [condition({ [column]: low }), condition({ [column]: high })];
    expect(canonicalConditions([highRow, lowRow])).toEqual([lowRow, highRow]);
    expect(canonicalConditions([lowRow, highRow])).toEqual([lowRow, highRow]);
  });

  it('compares a number column numerically, not as text', () => {
    // As text `10` sorts before `9`; as a line number it is after.
    const line9 = condition({ sourceLine: 9 });
    const line10 = condition({ sourceLine: 10 });
    expect(canonicalConditions([line10, line9])).toEqual([line9, line10]);
  });

  it('puts a null cell before any value', () => {
    const absent = condition({ sourcePath: null });
    // The lowest string there is, so only the null-first rule can put `absent` ahead.
    const empty = condition({ sourcePath: '' });
    expect(canonicalConditions([empty, absent])).toEqual([absent, empty]);
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
