/**
 * The row-set registry and the three accessors: what each spec declares, and that the accessors
 * return exactly the three registries, in order, each spec carrying its `kind`.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { computeContentKey, orderContentKeys, type ContentKey } from '../src/content-key.js';
import {
  allDerivedSpecs,
  compareRowSetIds,
  DERIVED_TABLES,
  isProjectionTable,
  isRowSetTable,
  projectionColumnTypes,
  queryableRelationSpecs,
  ROW_SET_TABLES,
  rowSetIdText,
  storedRelationSpecs,
  type RowSetId,
} from '../src/index.js';

const ROW_SET_NAMES = ['data__files', 'data__documents', 'data__nodes', 'data__conditions'];
/** The projection tables in registry order, stated rather than read off the registry: the oracle. */
const PROJECTION_NAMES = [
  'roots', 'resources', 'resource_realizations', 'resource_extents', 'resource_tags', 'realization_conditions',
  'claude_rule_patterns', 'resolution_contexts', 'zone_provenance', 'blobs', 'blob_references', 'blob_sections',
  'blob_conditions', 'harness_blob_facts', 'harness_blob_imports', 'skill_text_facts', 'skill_text_matches',
];

describe('ROW_SET_TABLES', () => {
  const specs = storedRelationSpecs().filter((spec) => isRowSetTable(spec));

  it('holds the data instance\'s four tables, by their relation names', () => {
    expect(specs.map((spec) => spec.name)).toStrictEqual(ROW_SET_NAMES);
    expect(ROW_SET_TABLES.dataNodes.name).toBe('data__nodes');
  });

  it('names exactly one head per instance', () => {
    const heads = new Map<string, string[]>();
    for (const spec of specs) {
      if (spec.head) heads.set(spec.instance, [...(heads.get(spec.instance) ?? []), spec.name]);
    }
    expect(Object.fromEntries(heads)).toStrictEqual({ data: ['data__files'] });
    expect(new Set(specs.map((spec) => spec.instance))).toStrictEqual(new Set(heads.keys()));
  });

  it('keys every table on blob and variant first, and every key column is a real column', () => {
    for (const spec of specs) {
      expect(spec.primaryKey.slice(0, 2), spec.name).toStrictEqual(['blob', 'variant']);
      for (const column of spec.primaryKey) expect(spec.columns, spec.name).toContain(column);
    }
  });

  it('holds both data variants on every table', () => {
    for (const spec of specs) expect(spec.variants, spec.name).toStrictEqual(['json', 'jsonc']);
  });

  it('classifies data__nodes.value and data__values.value as scalar, with their companions', () => {
    for (const spec of [ROW_SET_TABLES.dataNodes, DERIVED_TABLES.dataValues]) {
      const value = new Map(projectionColumnTypes(spec)).get('value');
      expect(value, spec.name).toStrictEqual({ kind: 'scalar', nullable: true, companions: { type: 'type', lexeme: 'lexeme' } });
    }
  });
});

describe('the relation accessors', () => {
  it('queryableRelationSpecs is projection, then row-set, then derived, each by its kind', () => {
    const kinds = queryableRelationSpecs().map((spec) => spec.kind);
    const runs = kinds.filter((kind, index) => index === 0 || kinds[index - 1] !== kind);
    expect(runs).toStrictEqual(['projection', 'rowSet', 'derived']);
    expect(queryableRelationSpecs().map((spec) => spec.name)).toStrictEqual([
      ...PROJECTION_NAMES,
      ...ROW_SET_NAMES,
      ...allDerivedSpecs().map((spec) => spec.name),
    ]);
  });

  it('storedRelationSpecs is projection then row-set, and nothing derived', () => {
    expect(storedRelationSpecs().map((spec) => spec.name)).toStrictEqual([...PROJECTION_NAMES, ...ROW_SET_NAMES]);
  });

  it('isProjectionTable and isRowSetTable split the queryable relations by kind', () => {
    const queryable = queryableRelationSpecs();
    expect(queryable.filter((spec) => isProjectionTable(spec)).map((spec) => spec.name)).toStrictEqual(PROJECTION_NAMES);
    expect(queryable.filter((spec) => isRowSetTable(spec)).map((spec) => spec.name)).toStrictEqual(ROW_SET_NAMES);
  });

  it('marks data__routes and data__values as produced by the data instance, every other derived relation by a lens', () => {
    const byProducer = (producer: string): string[] =>
      allDerivedSpecs().filter((spec) => spec.producer === producer).map((spec) => spec.name);
    expect(byProducer('data')).toStrictEqual(['data__routes', 'data__values']);
    expect([...byProducer('lens'), ...byProducer('data')].toSorted(compareCodeUnits))
      .toStrictEqual(allDerivedSpecs().map((spec) => spec.name).toSorted(compareCodeUnits));
  });

  it('keys the derived data relations on root and path first, so neither is rootless', () => {
    expect(DERIVED_TABLES.dataRoutes.primaryKey).toStrictEqual(['root', 'path']);
    expect(DERIVED_TABLES.dataValues.primaryKey).toStrictEqual(['root', 'path', 'variant', 'doc', 'pointer']);
  });
});

describe('row-set ids', () => {
  const keyOf = (text: string): ContentKey => computeContentKey(new TextEncoder().encode(text), 'none');
  // Named in key order, so the expected order below is stated rather than computed by the subject.
  const [keyA, keyB] = [keyOf('a'), keyOf('b')].toSorted(orderContentKeys) as [ContentKey, ContentKey];
  const id = (contentKey: ContentKey, variant: 'json' | 'jsonc'): RowSetId => ({ contentKey, instance: 'data', variant });

  it('gives equal text exactly to equal triples', () => {
    expect(rowSetIdText(id(keyA, 'json'))).toBe(rowSetIdText(id(keyA, 'json')));
    expect(rowSetIdText(id(keyA, 'json'))).not.toBe(rowSetIdText(id(keyA, 'jsonc')));
    expect(rowSetIdText(id(keyA, 'json'))).not.toBe(rowSetIdText(id(keyB, 'json')));
  });

  it('orders by content key, then variant', () => {
    const sorted = [id(keyB, 'json'), id(keyA, 'jsonc'), id(keyA, 'json')].toSorted(compareRowSetIds);
    expect(sorted).toStrictEqual([id(keyA, 'json'), id(keyA, 'jsonc'), id(keyB, 'json')]);
  });
});
