/**
 * Row bundles the store tests write and read back.
 *
 * Deliberately awkward rather than tidy: every value here is one the codec
 * could plausibly lose — `false`, `0`, `''`, a `Date`, a JSON `null`, a nested
 * object, a nullable key column holding null. A fixture of well-behaved strings
 * would pass against a broken codec.
 */

import type { BlobScopedRows, ExtentScopedRows } from '@vibe-agent-toolkit/resources';

/** A content key of the shape `ContentKeySchema` requires: `<parserKind>.<sha256>`. */
export function contentKey(seed: string): string {
  return `markdown.${seed.repeat(64).slice(0, 64)}`;
}

/** The first fixture blob's key, named once so tests do not restate it. */
export const FIRST_BLOB = contentKey('a');

/** A second blob, for the tests that need two. */
export const SECOND_BLOB = contentKey('b');

/**
 * Blob-scoped rows for one blob, exercising every column kind.
 *
 * @param key - Which content key the rows are about
 * @returns The four blob-scoped tables
 */
export function sampleBlobRows(key: string = FIRST_BLOB): BlobScopedRows {
  return {
    blobs: [{
      contentKey: key,
      bytes: 0,
      tokenEstimate: 12,
      frontmatter: { title: 'x', tags: ['a', 'b'], nested: { deep: null } },
      frontmatterError: null,
      wordCount: 3,
      proseBytes: 2,
      codeBlockBytes: 0,
      linkCount: 1,
      headingCount: 1,
      sectionCount: 1,
    }],
    blobReferences: [{
      blob: key,
      ordinal: 0,
      rawRef: './other.md',
      text: null,
      line: 1,
      column: null,
      startOffset: 0,
      endOffset: 11,
      syntacticForm: 'markdown-link',
      hasExtension: true,
      leadingAt: false,
      slashCount: 1,
      variableExpansion: null,
      inCodeSpan: false,
      inFence: false,
    }],
    blobSections: [{
      blob: key,
      ordinal: 0,
      depth: 1,
      title: 'Heading',
      slug: 'heading',
      slugOccurrence: 0,
      parentOrdinal: null,
      lineStart: 1,
      lineEnd: 2,
      bytes: 9,
      tokens: 2,
    }],
    // `line: null` is the case a nullable primary-key column makes interesting:
    // SQLite's unique index treats two NULLs as distinct, so a store relying on
    // a conflict clause would accumulate duplicates of exactly this row.
    blobConditions: [{
      blob: key,
      code: 'PARSE_ODDITY',
      severity: 'info',
      message: '',
      line: null,
    }],
  };
}

/**
 * Extent-scoped rows for one tree, exercising every column kind.
 *
 * @param rootId - The root these rows belong to
 * @returns The eight extent-scoped tables
 */
/**
 * One `resourceRealizations` row, varying only the three fields a caller cares
 * about and pinning the rest.
 *
 * Extracted because two suites were spelling the same eighteen-column row out in
 * full — this module's fixed sample and `store.test.ts`'s per-context builder —
 * and eighteen columns restated twice is eighteen chances for the two to drift
 * into describing different rows while both look plausible.
 *
 * @param fields - The identity, the context, and the path this row realizes
 * @param fields.resourceId - The identity the row realizes
 * @param fields.extentId - The context it belongs to
 * @param fields.path - Root-relative, forward-slashed
 * @returns The row
 */
export function realizationRow(fields: {
  resourceId: string;
  extentId: string;
  path: string;
}): ExtentScopedRows['resourceRealizations'][number] {
  return {
    resourceId: fields.resourceId,
    extentId: fields.extentId,
    path: fields.path,
    pathLower: fields.path,
    basenameLower: 'a.md',
    dir: 'docs',
    depth: 1,
    ext: '.md',
    contentKey: FIRST_BLOB,
    contentState: 'keyed',
    mtime: new Date('2026-08-18T12:34:56.789Z'),
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };
}

export function sampleExtentRows(rootId = 'root-1'): ExtentScopedRows {
  return {
    roots: [{ id: rootId, path: '/corpus' }],
    resources: [{
      resourceId: 'res-1',
      kind: 'file',
      origin: 'filesystem',
      observed: true,
      fromEnumeration: false,
      vatId: null,
    }],
    resourceRealizations: [
      realizationRow({ resourceId: 'res-1', extentId: 'ext-1', path: 'docs/a.md' }),
    ],
    resourceExtents: [{ resourceId: 'res-1', extentId: 'ext-1' }],
    resourceTags: [{ resourceId: 'res-1', tag: 'kind', value: null, source: 'filename' }],
    realizationConditions: [{
      extentId: 'ext-1',
      path: 'docs/a.md',
      code: 'REALIZATION_PATH_COLLISION',
      severity: 'warning',
      message: 'collided',
      resourceId: null,
      sourcePath: null,
      sourceLine: null,
      sourceRef: null,
      targetExists: null,
      matchedPattern: null,
      matchedPayload: null,
    }],
    resolutionContexts: [{
      contextId: 'ext-1',
      species: 'extent',
      kind: 'filesystem',
      rootId,
      extentContextId: null,
      role: null,
    }],
    zoneProvenance: [{
      contextId: 'ext-1',
      contributorId: 'filesystem',
      parameterSet: { include: ['**/*.md'], depth: 0 },
      extentDigest: 'digest-1',
    }],
  };
}
