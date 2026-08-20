import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { exportProjection } from '../src/projection/export.js';
import { ProjectionBuilder, type Projection } from '../src/projection/projection.js';
import { PROJECTION_TABLES, type ProjectionTableName } from '../src/projection/table-registry.js';

const ROOT = safePath.join(normalizedTmpdir(), 'vat-table-registry');

/**
 * The twelve tables, in {@link Projection}'s declaration order.
 *
 * `satisfies readonly (keyof Projection)[]` makes a renamed table a compile
 * error here; the runtime assertions below make an *added* or *removed* one a
 * red test, which is the half the compiler cannot cover once esbuild has
 * stripped the types.
 */
const EXPECTED_TABLES = [
  'roots',
  'resources',
  'resourceRealizations',
  'resourceExtents',
  'resourceTags',
  'realizationConditions',
  'resolutionContexts',
  'zoneProvenance',
  'blobs',
  'blobReferences',
  'blobSections',
  'blobConditions',
] as const satisfies readonly (keyof Projection)[];

/**
 * Every table's primary key, transcribed from `exportProjection`'s sort-key
 * lambdas as they stood *before* the registry existed.
 *
 * This is the characterization pin for the refactor: the export's byte-identity
 * across hosts is a claim about exactly these tuples, so a registry that
 * silently reordered or dropped a key component would change bytes no other
 * test in this package is positioned to notice.
 */
const EXPECTED_PRIMARY_KEYS: Record<ProjectionTableName, readonly string[]> = {
  roots: ['id'],
  resources: ['resourceId'],
  resourceRealizations: ['extentId', 'path'],
  resourceExtents: ['resourceId', 'extentId'],
  resourceTags: ['resourceId', 'tag', 'value', 'source'],
  realizationConditions: ['extentId', 'path', 'code', 'resourceId'],
  resolutionContexts: ['contextId'],
  zoneProvenance: ['contextId', 'contributorId'],
  blobs: ['contentKey'],
  blobReferences: ['blob', 'ordinal'],
  blobSections: ['blob', 'ordinal'],
  blobConditions: ['blob', 'code', 'line', 'message'],
};

/**
 * The snake_case name each table carries. Derived in production from the field
 * name; pinned here because a JSON Schema filename and a future
 * `COPY … FROM <table>` both spell it, and a derivation nobody checks is a
 * guess.
 */
const EXPECTED_SQL_NAMES: Record<ProjectionTableName, string> = {
  roots: 'roots',
  resources: 'resources',
  resourceRealizations: 'resource_realizations',
  resourceExtents: 'resource_extents',
  resourceTags: 'resource_tags',
  realizationConditions: 'realization_conditions',
  resolutionContexts: 'resolution_contexts',
  zoneProvenance: 'zone_provenance',
  blobs: 'blobs',
  blobReferences: 'blob_references',
  blobSections: 'blob_sections',
  blobConditions: 'blob_conditions',
};

/**
 * Full column lists for three tables, in the order their Zod schemas declare
 * them — the order a storage backend's `INSERT (<columns>)` will use.
 *
 * Three rather than twelve, chosen for what each one can break:
 * `resourceRealizations` and `resolutionContexts` are the two row schemas
 * wrapped in `.superRefine()`, so their shape sits one `ZodEffects` deep and a
 * registry that only looked for `.shape` would report nothing for them.
 * `blobReferences` is the one whose columns come partly from a spread
 * (`...LEXICAL_FEATURE_COLUMNS`), where "declaration order" is a claim about
 * spread order rather than about a single literal.
 */
const EXPECTED_COLUMNS = {
  resourceRealizations: [
    'resourceId',
    'extentId',
    'path',
    'pathLower',
    'basenameLower',
    'dir',
    'depth',
    'ext',
    'contentKey',
    'contentState',
    'mtime',
    'exists',
    'isDirectory',
    'gitignored',
    'isSymlink',
    'symlinkResolves',
  ],
  resolutionContexts: ['contextId', 'species', 'kind', 'rootId', 'extentContextId', 'role'],
  blobReferences: [
    'blob',
    'ordinal',
    'rawRef',
    'text',
    'line',
    'column',
    'startOffset',
    'endOffset',
    'syntacticForm',
    'hasExtension',
    'leadingAt',
    'slashCount',
    'variableExpansion',
    'inCodeSpan',
    'inFence',
  ],
} as const satisfies Partial<Record<ProjectionTableName, readonly string[]>>;

/** Every spec, paired with the key it is filed under. */
function specEntries(): readonly [ProjectionTableName, (typeof PROJECTION_TABLES)[ProjectionTableName]][] {
  return Object.entries(PROJECTION_TABLES) as [
    ProjectionTableName,
    (typeof PROJECTION_TABLES)[ProjectionTableName],
  ][];
}

/**
 * The declared column order, reached through `_def` rather than through the
 * accessors production uses.
 *
 * A second route to the same fact, so the assertion is not the implementation
 * agreeing with itself: `_def.schema` is how a `ZodEffects` holds its inner
 * type and `_def.shape()` is how a `ZodObject` holds its literal, neither of
 * which is `innerType()` or `.shape`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into Zod's internals on purpose
function declaredColumns(schema: any): readonly string[] {
  const def = schema._def as { schema?: unknown; shape?: () => Record<string, unknown> };
  if (def.schema !== undefined) {
    return declaredColumns(def.schema);
  }
  if (def.shape === undefined) {
    throw new TypeError('not an object schema');
  }
  return Object.keys(def.shape());
}

describe('PROJECTION_TABLES', () => {
  it('covers exactly the twelve tables of Projection, in declaration order', () => {
    expect(Object.keys(PROJECTION_TABLES)).toStrictEqual([...EXPECTED_TABLES]);
  });

  it('is filed under the key each spec names', () => {
    for (const [name, spec] of specEntries()) {
      expect(spec.key).toBe(name);
    }
  });

  it('lists the tables in the order the exported document emits them', () => {
    // Table order is part of the export's byte identity: a document whose keys
    // moved is a different document even with every row unchanged. Deriving the
    // export from the registry makes that order the registry's to state.
    const tables = exportProjection(new ProjectionBuilder(ROOT).build()).tables;

    expect(Object.keys(tables)).toStrictEqual(Object.keys(PROJECTION_TABLES));
  });

  it('gives every table the snake_case name SQL and the schema files spell', () => {
    expect(Object.fromEntries(specEntries().map(([name, spec]) => [name, spec.name])))
      .toStrictEqual(EXPECTED_SQL_NAMES);
  });
});

describe('PROJECTION_TABLES primary keys', () => {
  it('are the keys exportProjection sorted by before the registry existed', () => {
    expect(Object.fromEntries(specEntries().map(([name, spec]) => [name, [...spec.primaryKey]])))
      .toStrictEqual(EXPECTED_PRIMARY_KEYS);
  });

  it('name only real columns of their own row schema', () => {
    for (const [name, spec] of specEntries()) {
      expect(spec.primaryKey.length, name).toBeGreaterThan(0);
      for (const column of spec.primaryKey) {
        expect(spec.columns, name).toContain(column);
      }
    }
  });

  it('are the order exportProjection actually returns rows in', () => {
    // The behavioural half of the pin above: `realization_conditions` is keyed
    // on four columns, and these two rows differ only in the third. Inserted
    // high-then-low, they must come back low-then-high — which they only do if
    // `code` really is the third component of the key the export reads.
    const builder = new ProjectionBuilder(ROOT);
    for (const code of ['ZZZ_LATER', 'AAA_EARLIER']) {
      builder.addCondition({
        extentId: 'ctx',
        path: 'docs/a.md',
        code,
        severity: 'info',
        message: 'fixture',
        resourceId: 'res',
        sourcePath: null,
        sourceLine: null,
        sourceRef: null,
        targetExists: null,
        matchedPattern: null,
        matchedPayload: null,
      });
    }

    const rows = exportProjection(builder.build()).tables.realizationConditions;

    expect(rows.map((row) => row.code)).toStrictEqual(['AAA_EARLIER', 'ZZZ_LATER']);
  });

  it('order their components — a mixed string/number key is not commutative', () => {
    // `blob_sections` is keyed (blob, ordinal), one string then one number. Four
    // rows across TWO blobs with the ordinals crossed: keyed blob-first they come
    // back a2, a10, b2, b10; keyed ordinal-first they would come back a2, b2,
    // a10, b10. A fixture on a single blob cannot tell those apart, which is
    // exactly the shape of fixture that proves nothing.
    const builder = new ProjectionBuilder(ROOT);
    for (const blob of [`markdown.${'b'.repeat(64)}`, `markdown.${'a'.repeat(64)}`]) {
      for (const ordinal of [10, 2]) {
        builder.addBlobSection({
          blob,
          ordinal,
          depth: 1,
          title: 'H',
          slug: 'h',
          slugOccurrence: 0,
          parentOrdinal: null,
          lineStart: 1,
          lineEnd: 2,
          bytes: 10,
          characters: 10,
          tokens: 3,
        });
      }
    }

    const rows = exportProjection(builder.build()).tables.blobSections;

    expect(rows.map((row) => [row.blob[9], row.ordinal])).toStrictEqual([
      ['a', 2],
      ['a', 10],
      ['b', 2],
      ['b', 10],
    ]);
  });
});

describe('PROJECTION_TABLES columns', () => {
  it('follow the order each row schema declares, refinements and all', () => {
    for (const [name, spec] of specEntries()) {
      expect([...spec.columns], name).toStrictEqual([...declaredColumns(spec.schema)]);
    }
  });

  it('match the columns pinned for the two refined tables and the spread one', () => {
    for (const [name, columns] of Object.entries(EXPECTED_COLUMNS)) {
      expect([...PROJECTION_TABLES[name as keyof typeof EXPECTED_COLUMNS].columns], name)
        .toStrictEqual([...columns]);
    }
  });

  it('never come back empty — the failure mode of an unwrapped ZodEffects', () => {
    for (const [name, spec] of specEntries()) {
      expect(spec.columns.length, name).toBeGreaterThan(1);
    }
  });
});
