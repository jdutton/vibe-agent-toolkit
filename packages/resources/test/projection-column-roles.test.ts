/**
 * Every queryable relation classifies every `text` and `json` column — the kinds that can carry a
 * path — and nothing else: held both ways against the columns the row schema declares, so a new
 * column left unclassified reds, and so does an entry naming a column that is gone or of another
 * kind. The schema is that test's oracle. What the classification then withholds is named outright,
 * so a change to it is a reviewed edit here rather than a re-run of the implementation's filter.
 */

import { describe, expect, it } from 'vitest';

import {
  allDerivedSpecs,
  isProjectionTable,
  PROJECTION_TABLES,
  projectionColumnTypes,
  queryableRelationSpecs,
  rootlessPathRelations,
} from '../src/index.js';

/** One fixed order for column names, so the two sides compare as sets. */
function byName(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

/** Every relation a statement can name, from the one list. */
const QUERYABLE = queryableRelationSpecs();

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
  it('is exactly the relations whose rows carry a root-relative path and no root column', () => {
    expect(rootlessPathRelations()).toStrictEqual([
      'resource_realizations',
      'realization_conditions',
      'claude_rule_patterns',
      'zone_provenance',
      'edge_resolutions',
      'claude_context_chains',
      'claude_context_loads',
      'changed_files',
    ]);
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

describe('isProjectionTable', () => {
  it('tells every projection table from every derived relation, as the two registries list them', () => {
    expect(QUERYABLE.filter((spec) => isProjectionTable(spec)).map((spec) => spec.name))
      .toStrictEqual(Object.values(PROJECTION_TABLES).map((spec) => spec.name));
    expect(QUERYABLE.filter((spec) => !isProjectionTable(spec)).map((spec) => spec.name))
      .toStrictEqual(allDerivedSpecs().map((spec) => spec.name));
  });
});
