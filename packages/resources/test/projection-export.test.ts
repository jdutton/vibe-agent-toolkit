import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { ROOT_PATH_PLACEHOLDER, exportProjection, serializeProjection } from '../src/projection/export.js';
import { ProjectionBuilder, type Projection } from '../src/projection/projection.js';
import { PROJECTION_SCHEMA_VERSION } from '../src/schemas/projection-shared.js';

/**
 * Two real tmpdir-shaped roots. Nothing is written: the only thing under test
 * is that neither string survives into the serialized document.
 */
const TMP_ROOT_A = safePath.join(normalizedTmpdir(), 'vat-export-corpus-a');
const TMP_ROOT_B = safePath.join(normalizedTmpdir(), 'vat-export-corpus-b');

const ROOT_ID_A = 'root-aaaa';
const ROOT_ID_B = 'root-bbbb';

const EXTENT_A = 'ctx-a-filesystem';
const EXTENT_B = 'ctx-b-git';
const RES_A = 'res-aaaa';
const RES_B = 'res-bbbb';
const PATH_A = 'docs/a.md';
const PATH_B = 'docs/b.md';
const CONTRIBUTOR_ID = 'builtin:filesystem';
const CONDITION_CODE = 'PARSE_ODDITY';

const BLOB_A = `markdown.${'a'.repeat(64)}`;
const BLOB_B = `markdown.${'b'.repeat(64)}`;

/**
 * Section ordinals chosen so string order and numeric order disagree: sorting
 * by `String(ordinal)` would place 10 before 2.
 */
const HIGH_ORDINAL = 10;
const LOW_ORDINAL = 2;

/**
 * The twelve tables, taken from {@link Projection} itself so the compiler
 * rejects this list the moment a table is added or renamed.
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

/** One side of the fixture — every table gets a row keyed on this side's ids. */
interface Side {
  readonly rootId: string;
  readonly rootPath: string;
  readonly extentId: string;
  readonly resourceId: string;
  readonly path: string;
  readonly blob: string;
  readonly sectionOrdinal: number;
}

const SIDE_A: Side = {
  rootId: ROOT_ID_A,
  rootPath: TMP_ROOT_A,
  extentId: EXTENT_A,
  resourceId: RES_A,
  path: PATH_A,
  blob: BLOB_A,
  // Deliberately the HIGH ordinal on the LOW side: whichever way the two sides
  // are inserted, sections must come back 2 then 10.
  sectionOrdinal: HIGH_ORDINAL,
};

const SIDE_B: Side = {
  rootId: ROOT_ID_B,
  rootPath: TMP_ROOT_B,
  extentId: EXTENT_B,
  resourceId: RES_B,
  path: PATH_B,
  blob: BLOB_B,
  sectionOrdinal: LOW_ORDINAL,
};

/** Contribute one side's rows to every one of the twelve tables. */
function contribute(builder: ProjectionBuilder, side: Side): void {
  builder.addRoot({ id: side.rootId, path: side.rootPath });
  builder.addResource({
    resourceId: side.resourceId,
    kind: 'file',
    origin: 'filesystem',
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });
  builder.addRealization({
    resourceId: side.resourceId,
    extentId: side.extentId,
    path: side.path,
    pathLower: side.path,
    basenameLower: side.path.slice(side.path.lastIndexOf('/') + 1),
    dir: 'docs',
    depth: 2,
    ext: '.md',
    contentKey: side.blob,
    contentState: 'keyed',
    mtime: null,
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  });
  builder.addExtentMembership({ resourceId: side.resourceId, extentId: side.extentId });
  builder.addTag({ resourceId: side.resourceId, tag: 'doc', value: null, source: 'filename' });
  builder.addCondition({
    extentId: side.extentId,
    path: side.path,
    code: CONDITION_CODE,
    severity: 'info',
    message: 'fixture condition',
    resourceId: side.resourceId,
  });
  builder.addContext({
    contextId: side.extentId,
    species: 'extent',
    kind: 'filesystem',
    rootId: side.rootId,
    extentContextId: null,
    role: null,
  });
  builder.addProvenance({
    contextId: side.extentId,
    contributorId: CONTRIBUTOR_ID,
    parameterSet: null,
    extentDigest: 'digest-fixture',
  });
  builder.addBlob({
    contentKey: side.blob,
    bytes: 10,
    tokenEstimate: 3,
    frontmatter: null,
    frontmatterError: null,
    wordCount: 2,
    proseBytes: 10,
    codeBlockBytes: 0,
    linkCount: 0,
    headingCount: 1,
    sectionCount: 1,
  });
  builder.addBlobReference({
    blob: side.blob,
    ordinal: 0,
    rawRef: './other.md',
    text: 'other',
    line: 1,
    column: null,
    syntacticForm: 'markdown-link',
    hasExtension: true,
    leadingAt: false,
    slashCount: 1,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: false,
  });
  // Both sections land on BLOB_A so that (blob, ordinal) ordering is exercised
  // on a single blob rather than merely following the blob key.
  builder.addBlobSection({
    blob: BLOB_A,
    ordinal: side.sectionOrdinal,
    depth: 1,
    title: 'Heading',
    slug: 'heading',
    slugOccurrence: 0,
    parentOrdinal: null,
    lineStart: 1,
    lineEnd: 2,
    bytes: 10,
    tokens: 3,
  });
  builder.addBlobCondition({
    blob: side.blob,
    code: CONDITION_CODE,
    severity: 'info',
    message: 'fixture oddity',
    line: null,
  });
}

/**
 * Build the same projection with the two sides contributed in the given order.
 *
 * Insertion order is the whole point: one of `crawlDirectory`'s two routes
 * enumerates in filesystem order, which differs between ext4, APFS and NTFS, so
 * an export that carried insertion order would make any future golden
 * host-dependent.
 */
function buildFixture(order: 'forward' | 'reverse'): Projection {
  const builder = new ProjectionBuilder(TMP_ROOT_A);
  const sides = order === 'forward' ? [SIDE_A, SIDE_B] : [SIDE_B, SIDE_A];
  for (const side of sides) {
    contribute(builder, side);
  }
  return builder.build();
}

describe('exportProjection', () => {
  it('stamps the projection schema version', () => {
    expect(exportProjection(buildFixture('forward')).schemaVersion).toBe(PROJECTION_SCHEMA_VERSION);
  });

  it('carries all twelve tables as keys even when every one is empty', () => {
    // A missing key and an empty array are different claims. A consumer must not
    // have to guess which one an absent table meant.
    const tables = exportProjection(new ProjectionBuilder(TMP_ROOT_A).build()).tables;

    expect(Object.keys(tables)).toHaveLength(EXPECTED_TABLES.length);
    for (const name of EXPECTED_TABLES) {
      expect(tables[name]).toEqual([]);
    }
  });

  it('replaces every root path with a stable placeholder', () => {
    const roots = exportProjection(buildFixture('forward')).tables.roots;

    expect(roots).toHaveLength(2);
    expect(roots.map((row) => row.path)).toEqual([ROOT_PATH_PLACEHOLDER, ROOT_PATH_PLACEHOLDER]);
    // The ids still tell the two roots apart, which is what `path` was never
    // allowed to be used for anyway.
    expect(roots.map((row) => row.id)).toEqual([ROOT_ID_A, ROOT_ID_B]);
  });

  it('sorts each table by its primary key, numerically where the key is a number', () => {
    const tables = exportProjection(buildFixture('reverse')).tables;

    expect(tables.resourceRealizations.map((row) => row.extentId)).toEqual([EXTENT_A, EXTENT_B]);
    expect(tables.resources.map((row) => row.resourceId)).toEqual([RES_A, RES_B]);
    // String order would put 10 before 2.
    expect(tables.blobSections.map((row) => row.ordinal)).toEqual([LOW_ORDINAL, HIGH_ORDINAL]);
  });
});

describe('serializeProjection', () => {
  it('is byte-identical across two runs over the same projection', () => {
    const projection = buildFixture('forward');
    expect(serializeProjection(projection)).toBe(serializeProjection(projection));
  });

  it('is byte-identical when the same rows were contributed in a different order', () => {
    // The negative control for this test is deleting the sort in export.ts: it
    // must go red, or the test is agreeing with insertion order by luck.
    expect(serializeProjection(buildFixture('forward')))
      .toBe(serializeProjection(buildFixture('reverse')));
  });

  it('leaks no absolute filesystem path', () => {
    // Asserted by grepping the output, not by inspecting the fields: this repo
    // has already shipped evidence leaking $HOME once.
    const serialized = serializeProjection(buildFixture('forward'));

    expect(serialized).not.toContain(TMP_ROOT_A);
    expect(serialized).not.toContain(TMP_ROOT_B);
    expect(serialized).not.toContain(normalizedTmpdir());
  });
});
