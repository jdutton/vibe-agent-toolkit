/**
 * The builder's de-duplication keys are the registry's primary keys.
 *
 * `PROJECTION_TABLES` declares each table's primary key as data;
 * `ProjectionBuilder` states the same twelve keys again as `ProjectionTable`
 * closures, and nothing in the production code makes the two agree. A
 * divergence there is not an ordering wobble — it changes which rows are
 * **de-duplicated**, so the projection would carry a different row set.
 *
 * ## What is pinned, and how
 *
 * The keys are closures, so there is no array to read off them. Reading
 * `projection.ts`'s source text with a regex would pin the spelling rather than
 * the behaviour, so the correspondence is established the only way it is
 * observable — by contributing rows and counting what survives:
 *
 * - **Every declared key column is load-bearing.** Two rows differing in
 *   *exactly one* key column and identical everywhere else must both survive.
 *   One column at a time is what makes this immune to the correlated-fixture
 *   trap: there is no second column moving alongside it that could account for
 *   the outcome.
 * - **Nothing outside the declared key is.** One row, then a second that differs
 *   in *every* non-key column at once, must collapse to one row.
 *
 * Together those two make the observed key exactly the declared set: adding a
 * column to a closure reddens the second, dropping or substituting one reddens
 * the first. Both halves were swept rather than argued — dropping a component
 * from each of the twelve closures in turn reddens that table and only that
 * table (12/12), and widening each key with one non-key column reddens its table
 * too (10/10; `resource_extents` and `resource_tags` have no non-key column to
 * add).
 *
 * ## Order is deliberately not pinned here, because it is not observable here
 *
 * `compositeKey` joins its parts with a NUL, which no id, path or number can
 * contain, so the encoding is injective: `join(a, b) === join(c, d)` exactly
 * when `a === c` and `b === d`. Permuting a closure's components is therefore a
 * bijection on key tuples and leaves *every* de-duplication outcome unchanged —
 * no fixture of well-formed rows can distinguish it, and a test claiming to
 * would be passing for a reason other than the one it states. Measured with the
 * same sweep: permuting each of the eight multi-column closures leaves this file
 * green 8/8, which is the argument holding rather than the fixture failing.
 *
 * Component order still matters, but only where it is read as an ordering: the
 * export's sort. `projection-table-registry.test.ts` pins it there, behaviourally
 * ("order their components — a mixed string/number key is not commutative") and
 * by transcription.
 */

import { describe, expect, it } from 'vitest';

import { ProjectionBuilder } from '../src/projection/projection.js';
import {
  PROJECTION_TABLES,
  type ProjectionRow,
  type ProjectionTableName,
} from '../src/projection/table-registry.js';

/** A corpus root. Nothing here touches disk; the builder only needs a string. */
const ROOT = '/vat-corpus/dedup';

const BLOB_BASE = `markdown.${'a'.repeat(64)}`;
const BLOB_ALT = `html.${'b'.repeat(64)}`;

/** The base path, shared by the two tables whose key names a path. */
const PATH_BASE = 'lib/base.md';

/** A row read column-wise, which is how the table-driven machinery below works. */
type RowRecord = Readonly<Record<string, unknown>>;

/** One table's two rows, plus the door through which they reach the builder. */
interface TableFixture {
  /** The {@link PROJECTION_TABLES} entry this fixture exercises. */
  readonly name: ProjectionTableName;
  /** A well-formed row of the table. */
  readonly base: RowRecord;
  /** A well-formed row differing from {@link base} in **every** column. */
  readonly alt: RowRecord;
  /**
   * Contribute `base`, then `base` with `overrides` applied, to a fresh builder.
   *
   * @param overrides - Columns to take from {@link alt} on the second row
   * @returns How many rows of this table survived
   */
  readonly rowsAfterPair: (overrides: RowRecord) => number;
}

/**
 * Read a row as an untyped record.
 *
 * The one cast in this file, and it widens rather than narrows: the assertions
 * below are generic over twelve unrelated row types and address columns by name.
 *
 * @param row - Any projection row
 * @returns The same object, typed column-wise
 */
function asRecord(row: object): RowRecord {
  return row as RowRecord;
}

/**
 * Describe one table's fixture, keeping the row types tied to the table name.
 *
 * @param name - The registry key of the table
 * @param add - The builder method that contributes one of its rows
 * @param base - A well-formed row
 * @param alt - A well-formed row differing from `base` in every column
 * @returns The type-erased fixture the assertions iterate over
 */
function fixture<Name extends ProjectionTableName>(
  name: Name,
  add: (builder: ProjectionBuilder, row: ProjectionRow<Name>) => unknown,
  base: ProjectionRow<Name>,
  alt: ProjectionRow<Name>,
): TableFixture {
  return {
    name,
    base: asRecord(base),
    alt: asRecord(alt),
    rowsAfterPair(overrides: RowRecord): number {
      const builder = new ProjectionBuilder(ROOT);
      add(builder, base);
      add(builder, { ...base, ...overrides } as ProjectionRow<Name>);
      return builder.build()[name].length;
    },
  };
}

/**
 * The twelve fixtures, in the registry's own declaration order.
 *
 * Every `alt` differs from its `base` in **every** column — asserted below
 * rather than assumed, because a fixture whose columns move together is exactly
 * how a permuted or truncated key stays green.
 */
const FIXTURES: readonly TableFixture[] = [
  fixture(
    'roots',
    (builder, row) => builder.addRoot(row),
    { id: 'root-base', path: '/vat-corpus/dedup' },
    { id: 'root-alt', path: '/vat-corpus/other' },
  ),
  fixture(
    'resources',
    (builder, row) => builder.addResource(row),
    { resourceId: 'res-base', kind: 'file', origin: 'filesystem', observed: true, fromEnumeration: true, vatId: null },
    { resourceId: 'res-alt', kind: 'skill', origin: 'config', observed: false, fromEnumeration: false, vatId: 'vat-alt' },
  ),
  fixture(
    'resourceRealizations',
    (builder, row) => builder.addRealization(row),
    {
      resourceId: 'res-base',
      extentId: 'ctx-base',
      path: PATH_BASE,
      pathLower: PATH_BASE,
      basenameLower: 'base.md',
      dir: 'lib',
      depth: 2,
      ext: '.md',
      contentKey: null,
      contentState: 'deferred',
      mtime: null,
      exists: true,
      isDirectory: false,
      gitignored: false,
      isSymlink: false,
      symlinkResolves: null,
    },
    {
      resourceId: 'res-alt',
      extentId: 'ctx-alt',
      path: 'src/Alt.TXT',
      pathLower: 'src/alt.txt',
      basenameLower: 'alt.txt',
      dir: 'src',
      depth: 3,
      ext: '.txt',
      // `contentKey`/`contentState` and `isSymlink`/`symlinkResolves` are the two
      // pairs the row schema's superRefine ties together, so each moves as a pair.
      // Neither pair is a key column, so no assertion below perturbs one alone.
      contentKey: BLOB_ALT,
      contentState: 'keyed',
      mtime: new Date(Date.UTC(2020, 0, 2)),
      exists: false,
      isDirectory: true,
      gitignored: true,
      isSymlink: true,
      symlinkResolves: true,
    },
  ),
  fixture(
    'resourceExtents',
    (builder, row) => builder.addExtentMembership(row),
    { resourceId: 'res-base', extentId: 'ctx-base' },
    { resourceId: 'res-alt', extentId: 'ctx-alt' },
  ),
  fixture(
    'resourceTags',
    (builder, row) => builder.addTag(row),
    { resourceId: 'res-base', tag: 'kind', value: 'guide', source: 'frontmatter' },
    { resourceId: 'res-alt', tag: 'topic', value: null, source: 'config' },
  ),
  fixture(
    'realizationConditions',
    (builder, row) => builder.addCondition(row),
    {
      extentId: 'ctx-base',
      path: PATH_BASE,
      code: 'BASE_CODE',
      severity: 'info',
      message: 'base message',
      resourceId: 'res-base',
      sourcePath: 'lib/referrer.md',
      sourceLine: 7,
      sourceRef: './base.md',
      targetExists: false,
      matchedPattern: 'lib/**',
      matchedPayload: null,
    },
    {
      extentId: 'ctx-alt',
      path: 'src/alt.md',
      code: 'ALT_CODE',
      severity: 'error',
      message: 'alt message',
      resourceId: null,
      sourcePath: null,
      sourceLine: null,
      sourceRef: null,
      targetExists: null,
      matchedPattern: null,
      matchedPayload: { rule: 1 },
    },
  ),
  fixture(
    'resolutionContexts',
    (builder, row) => builder.addContext(row),
    { contextId: 'ctx-base', species: 'extent', kind: 'filesystem', rootId: 'root-base', extentContextId: null, role: null },
    { contextId: 'ctx-alt', species: 'lens', kind: 'tree', rootId: 'root-alt', extentContextId: 'ctx-base', role: 'dist' },
  ),
  fixture(
    'zoneProvenance',
    (builder, row) => builder.addProvenance(row),
    { contextId: 'ctx-base', contributorId: 'builtin:git', parameterSet: null, extentDigest: 'digest-base' },
    { contextId: 'ctx-alt', contributorId: 'builtin:filesystem', parameterSet: { globs: ['**/*.md'] }, extentDigest: 'digest-alt' },
  ),
  fixture(
    'blobs',
    (builder, row) => builder.addBlob(row),
    {
      contentKey: BLOB_BASE,
      bytes: 120,
      tokenEstimate: 30,
      frontmatter: null,
      frontmatterError: null,
      wordCount: 20,
      proseBytes: 100,
      codeBlockBytes: 20,
      linkCount: 2,
      headingCount: 3,
      sectionCount: 3,
    },
    {
      contentKey: BLOB_ALT,
      bytes: 240,
      tokenEstimate: 60,
      frontmatter: { title: 'alt' },
      frontmatterError: 'frontmatter is not a mapping',
      wordCount: 40,
      proseBytes: 200,
      codeBlockBytes: 40,
      linkCount: 4,
      headingCount: 6,
      sectionCount: 6,
    },
  ),
  fixture(
    'blobReferences',
    (builder, row) => builder.addBlobReference(row),
    {
      blob: BLOB_BASE,
      ordinal: 0,
      rawRef: './base.md',
      text: 'base',
      line: 3,
      column: 5,
      startOffset: 10,
      endOffset: 20,
      syntacticForm: 'markdown-link',
      hasExtension: true,
      leadingAt: false,
      slashCount: 1,
      variableExpansion: null,
      inCodeSpan: false,
      inFence: false,
    },
    {
      blob: BLOB_ALT,
      ordinal: 7,
      rawRef: '@scope/pkg',
      text: null,
      line: 9,
      column: null,
      startOffset: 30,
      endOffset: 44,
      syntacticForm: 'at-prefixed',
      hasExtension: false,
      leadingAt: true,
      slashCount: 2,
      variableExpansion: 'brace',
      inCodeSpan: true,
      inFence: true,
    },
  ),
  fixture(
    'blobSections',
    (builder, row) => builder.addBlobSection(row),
    {
      blob: BLOB_BASE,
      ordinal: 0,
      depth: 1,
      title: 'Base',
      slug: 'base',
      slugOccurrence: 0,
      parentOrdinal: null,
      lineStart: 1,
      lineEnd: 9,
      bytes: 120,
      tokens: 30,
    },
    {
      blob: BLOB_ALT,
      ordinal: 7,
      depth: 3,
      title: 'Alt',
      slug: 'alt',
      slugOccurrence: 2,
      parentOrdinal: 1,
      lineStart: 11,
      lineEnd: 19,
      bytes: 240,
      tokens: 60,
    },
  ),
  fixture(
    'blobConditions',
    (builder, row) => builder.addBlobCondition(row),
    { blob: BLOB_BASE, code: 'PARSE_ODDITY', severity: 'info', message: 'base oddity', line: 4 },
    { blob: BLOB_ALT, code: 'FRONTMATTER_UNPARSED', severity: 'error', message: 'alt oddity', line: null },
  ),
];

/**
 * Every column of a table that its primary key does **not** name.
 *
 * @param name - The registry key of the table
 * @returns The non-key columns, in declaration order
 */
function nonKeyColumns(name: ProjectionTableName): readonly string[] {
  const spec = PROJECTION_TABLES[name];
  const key = new Set<string>(spec.primaryKey);
  return spec.columns.filter((column) => !key.has(column));
}

/**
 * The alt values of a set of columns, ready to spread over a base row.
 *
 * @param entry - The fixture to take values from
 * @param columns - The columns to take
 * @returns An override record covering exactly those columns
 */
function altValues(entry: TableFixture, columns: readonly string[]): RowRecord {
  return Object.fromEntries(columns.map((column) => [column, entry.alt[column]]));
}

describe('ProjectionBuilder de-duplication keys', () => {
  it('are exercised for every table the registry declares', () => {
    // A thirteenth table would otherwise be silently unguarded: it would compile,
    // and no assertion below would ever mention it.
    expect(FIXTURES.map((entry) => entry.name)).toStrictEqual(Object.keys(PROJECTION_TABLES));
  });
});

describe.each(FIXTURES)('$name de-duplication', (entry) => {
  const spec = PROJECTION_TABLES[entry.name];

  it('is fixtured with two rows its own schema accepts', () => {
    // `.strict()` on every row schema makes this pin the column set too: a fixture
    // that missed a new column, or invented one, cannot parse.
    expect(() => spec.schema.parse(entry.base)).not.toThrow();
    expect(() => spec.schema.parse(entry.alt)).not.toThrow();
  });

  it.each([...spec.columns])('varies %s independently between the two rows', (column) => {
    // The fixture-power guard. A key column whose two values coincided would make
    // the "both rows survive" assertion below unfalsifiable for that column.
    expect(entry.alt[column]).not.toStrictEqual(entry.base[column]);
  });

  it('collapses two rows that agree on the whole key and differ everywhere else', () => {
    // Reddens if the builder's closure names any column the registry's key does
    // not: that column differs here, so the rows would no longer collide.
    expect(entry.rowsAfterPair(altValues(entry, nonKeyColumns(entry.name)))).toBe(1);
  });

  it.each([...spec.primaryKey])('keeps both rows when only %s differs', (column) => {
    // Reddens if the builder's closure drops or substitutes this column: the rows
    // are identical apart from it, so they would collide.
    expect(entry.rowsAfterPair(altValues(entry, [column]))).toBe(2);
  });
});
