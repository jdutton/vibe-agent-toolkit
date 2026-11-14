/**
 * Every queryable relation classifies every `text` and `json` column — the kinds that can carry a
 * path — and nothing else: held both ways against the columns the row schema declares, so a new
 * column left unclassified reds, and so does an entry naming a column that is gone or of another
 * kind. No expected list is kept here — the schema is the oracle.
 */

import { describe, expect, it } from 'vitest';

import {
  allDerivedSpecs,
  PROJECTION_TABLES,
  projectionColumnTypes,
  rootlessPathRelations,
} from '../src/index.js';

/** One fixed order for column names, so the two sides compare as sets. */
function byName(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

/** Every relation a statement can name: the tables, then the derived relations. */
const QUERYABLE = [...Object.values(PROJECTION_TABLES), ...allDerivedSpecs()];

describe('columnRoles', () => {
  it.each(QUERYABLE.map((spec) => [spec.name, spec] as const))('%s classifies exactly its text and json columns', (_name, spec) => {
    const text = projectionColumnTypes(spec)
      .filter(([, type]) => type.kind === 'text' || type.kind === 'json')
      .map(([column]) => column)
      .sort(byName);
    expect(Object.keys(spec.columnRoles).sort(byName)).toStrictEqual(text);
  });
});

describe('rootlessPathRelations', () => {
  it('is every queryable relation with a root-relative path column and no root column', () => {
    const expected = QUERYABLE
      .filter((spec) => !(spec.columns as readonly string[]).includes('root'))
      .filter((spec) => Object.values<string | undefined>(spec.columnRoles).includes('rootRelativePath'))
      .map((spec) => spec.name);
    expect(rootlessPathRelations()).toStrictEqual(expected);
  });

  it('withholds the realizations and keeps the blob tier, whose rows are a function of bytes', () => {
    expect(rootlessPathRelations()).toContain('resource_realizations');
    expect(rootlessPathRelations()).not.toContain('blobs');
    // `roots.path` is absolute: it names its root by itself.
    expect(rootlessPathRelations()).not.toContain('roots');
  });

  it('withholds zone provenance, whose parameter set holds root-relative closure roots and globs', () => {
    expect(rootlessPathRelations()).toContain('zone_provenance');
  });
});
