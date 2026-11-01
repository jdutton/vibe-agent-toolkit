import { describe, expect, it } from 'vitest';

import { __internal } from '../src/projection/resource-population.js';
import { CONDITION_WITHOUT_REFERENCE, type RealizationConditionRow } from '../src/schemas/projection-resources.js';

const { canonicalEnumeration } = __internal;

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

const UNLISTABLE = condition({ code: 'EXTENT_DIRECTORY_UNLISTABLE', path: 'locked', severity: 'warning' });
const SYMLINK_B = condition({ path: 'docs/b.md' });
const SYMLINK_A = condition({ path: 'docs/a.md' });
// Equal on code, path, extentId AND message: only later columns tell them apart,
// so a comparator that stops at message leaves them in whatever order arrived.
const TIE_LOW = condition({ severity: 'info', resourceId: 'r-1' });
const TIE_HIGH = condition({ severity: 'warning', resourceId: 'r-2', sourceLine: 3, sourcePath: 'docs/x.md' });

describe('canonicalEnumeration — the one order a population leaves in, derived or stored', () => {
  it('sorts paths by code unit, whatever order they arrived in', () => {
    const { paths } = canonicalEnumeration(['/r/b.md', '/r/B.md', '/r/a.md', '/r/a/z.md'], []);
    expect(paths).toEqual(['/r/B.md', '/r/a.md', '/r/a/z.md', '/r/b.md']);
  });

  it('sorts conditions by code, then path', () => {
    const { conditions } = canonicalEnumeration([], [SYMLINK_B, UNLISTABLE, SYMLINK_A]);
    expect(conditions).toEqual([UNLISTABLE, SYMLINK_A, SYMLINK_B]);
  });

  it('is TOTAL over the row: rows equal on every leading column still come out in one order', () => {
    const forward = canonicalEnumeration([], [TIE_LOW, TIE_HIGH, UNLISTABLE]).conditions;
    const reversed = canonicalEnumeration([], [UNLISTABLE, TIE_HIGH, TIE_LOW]).conditions;
    expect(reversed).toEqual(forward);
    expect(forward[0]).toEqual(UNLISTABLE);
  });

  it('does not reorder its inputs in place', () => {
    const paths = ['/r/b.md', '/r/a.md'];
    const conditions = [SYMLINK_B, SYMLINK_A];
    canonicalEnumeration(paths, conditions);
    expect(paths).toEqual(['/r/b.md', '/r/a.md']);
    expect(conditions).toEqual([SYMLINK_B, SYMLINK_A]);
  });
});
