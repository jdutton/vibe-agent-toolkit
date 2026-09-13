/**
 * The comment-density ratchet is a pair of pure functions — measure a source
 * text, compare a package table to its ceilings — and one real-tree case that
 * IS the gate. The comparator cases pin both directions: a package that rises
 * above its ceiling fails, and a package that falls a whole point below fails
 * until the ceiling is lowered, so the table can only ever move down.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyLine,
  compareToCeilings,
  densityPercent,
  measureSource,
  renderCeilingsModule,
  type CommentDensity,
} from '../src/comment-density.js';

const density = (commentLines: number, nonBlankLines: number): CommentDensity => ({
  commentLines,
  nonBlankLines,
  percent: densityPercent({ commentLines, nonBlankLines }),
});

describe('classifyLine', () => {
  it.each([
    ['', 'blank'],
    ['   ', 'blank'],
    ['\t', 'blank'],
    ['// a line comment', 'comment'],
    ['  // indented', 'comment'],
    ['/** a doc block */', 'comment'],
    ['/* a block */', 'comment'],
    [' * inside a block', 'comment'],
    [' */', 'comment'],
    ['const a = 1;', 'code'],
    ['const a = 1; // trailing', 'code'],
    [String.raw`const re = /\*/;`, 'code'],
    ['*', 'comment'],
  ] as const)('%j → %s', (line, expected) => {
    expect(classifyLine(line)).toBe(expected);
  });
});

describe('measureSource', () => {
  it('counts comment and non-blank lines the way the audit did', () => {
    const text = [
      '/**',
      ' * Two doc lines.',
      ' */',
      'export const a = 1;',
      '',
      '// one line comment',
      'export const b = 2; // trailing comments are code',
      '   ',
    ].join('\n');
    expect(measureSource(text)).toEqual({ commentLines: 4, nonBlankLines: 6 });
  });

  it('accepts CRLF line endings', () => {
    expect(measureSource('// c\r\nconst a = 1;\r\n')).toEqual({ commentLines: 1, nonBlankLines: 2 });
  });

  it('measures an empty file as zero lines', () => {
    expect(measureSource('')).toEqual({ commentLines: 0, nonBlankLines: 0 });
  });
});

describe('densityPercent', () => {
  it('is comment lines over non-blank lines, to one decimal', () => {
    expect(densityPercent({ commentLines: 1, nonBlankLines: 3 })).toBeCloseTo(33.3, 10);
    expect(densityPercent({ commentLines: 2, nonBlankLines: 3 })).toBeCloseTo(66.7, 10);
    expect(densityPercent({ commentLines: 0, nonBlankLines: 3 })).toBe(0);
  });

  it('is zero, not NaN, for a package with no non-blank lines', () => {
    expect(densityPercent({ commentLines: 0, nonBlankLines: 0 })).toBe(0);
  });
});

describe('compareToCeilings', () => {
  it('passes a package sitting at or just under its ceiling', () => {
    const densities = new Map([['utils', density(500, 1000)]]);
    expect(compareToCeilings(densities, { utils: 50 })).toEqual([]);
    expect(compareToCeilings(densities, { utils: 50.9 })).toEqual([]);
  });

  it('fails a package that rose above its ceiling', () => {
    const densities = new Map([['utils', density(501, 1000)]]);
    const findings = compareToCeilings(densities, { utils: 50 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ package: 'utils', kind: 'rose', percent: 50.1, ceiling: 50 });
  });

  it('fails a package that fell a whole point below its ceiling, until the ceiling is lowered', () => {
    const densities = new Map([['utils', density(490, 1000)]]);
    const findings = compareToCeilings(densities, { utils: 50 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ package: 'utils', kind: 'fell', percent: 49, ceiling: 50 });
    // Lowering the ceiling to the rounded-up measurement clears it.
    expect(compareToCeilings(densities, { utils: 49 })).toEqual([]);
  });

  it('tolerates a fall of less than a point', () => {
    const densities = new Map([['utils', density(491, 1000)]]);
    expect(compareToCeilings(densities, { utils: 50 })).toEqual([]);
  });

  it('fails a package with sources but no ceiling, and a ceiling with no package', () => {
    const densities = new Map([['utils', density(1, 10)]]);
    const findings = compareToCeilings(densities, { gone: 12 });
    expect(findings.map((f) => [f.package, f.kind])).toEqual([
      ['gone', 'stale-entry'],
      ['utils', 'missing-entry'],
    ]);
  });

  it('reports findings sorted by package name', () => {
    const densities = new Map([
      ['zeta', density(9, 10)],
      ['alpha', density(9, 10)],
    ]);
    const findings = compareToCeilings(densities, { alpha: 10, zeta: 10 });
    expect(findings.map((f) => f.package)).toEqual(['alpha', 'zeta']);
  });
});

describe('renderCeilingsModule', () => {
  it('rounds every measurement UP to a tenth and lists packages in order', () => {
    const densities = new Map([
      ['zeta', density(1, 3)], // 33.3
      ['alpha', density(2, 3)], // 66.7
      ['exact', density(1, 2)], // 50.0
    ]);
    const source = renderCeilingsModule(densities);
    expect(source).toContain("  'alpha': 66.7,\n  'exact': 50,\n  'zeta': 33.4,\n");
    expect(source).toContain('export const COMMENT_DENSITY_CEILINGS');
  });

  it('rounds up, never to nearest', () => {
    // 1/7 = 14.2857… → 14.3 rounded up; 14.29 to nearest would also be 14.3,
    // so use 1/9 = 11.11… → 11.2 rounded up, 11.1 to nearest.
    const source = renderCeilingsModule(new Map([['p', density(1, 9)]]));
    expect(source).toContain("  'p': 11.2,");
  });
});

// The real-tree case — every package within its ceiling — reads ~800 source
// files and lives in `test/integration/comment-density.integration.test.ts`;
// the structure gate runs the same check.
