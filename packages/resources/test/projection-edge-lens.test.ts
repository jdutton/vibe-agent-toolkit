import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

import {
  AUTHORED_EDGE_FORMS,
  resolveEdges,
  type EdgeLens,
} from '../src/projection/edge-lens.js';
import type { Projection } from '../src/projection/projection.js';
import type {
  BlobReferenceRow,
  ReferenceSyntacticForm,
} from '../src/schemas/projection-blobs.js';
import {
  EdgeResolutionRowSchema,
  EdgeRowSchema,
} from '../src/schemas/projection-edges.js';

import { queryRealization } from './helpers/context-query-rows.js';

/**
 * A corpus root that need not exist on disk.
 *
 * The claim this pins is `claude-context-query.ts`'s: resolution reads
 * materialised columns, not the filesystem. If a resolution path ever starts
 * stat-ing for an ordinary relative href, these tests fail rather than the
 * claim quietly becoming false. Built from `normalizedTmpdir()` rather than a
 * `/`-rooted literal, which on Windows would carry no drive letter.
 */
const ROOT = safePath.join(normalizedTmpdir(), 'edge-lens-corpus');

/** The referring file in every single-source fixture. */
const SOURCE = 'a.md';
/** A second corpus member, used as a resolvable target. */
const TARGET = 'b.md';
/** The referring file in the nested fixtures. */
const GUIDE = 'docs/guide.md';
/** A target beside {@link GUIDE}. */
const DOCS_TARGET = 'docs/target.md';
/** The destination class for anything the corpus does not contain but that is a path. */
const OUT_OF_CORPUS = 'out-of-corpus';
/** An external URL used across the classification assertions. */
const EXTERNAL_URL = 'https://example.com/x';
/** A relative href naming a file the fixture corpus deliberately does not realize. */
const MISSING_HREF = './missing.md';

const LENS: EdgeLens = {
  contextId: 'lens:links',
  extentContextId: 'extent:fs',
  forms: AUTHORED_EDGE_FORMS,
  dialect: 'href',
};

/**
 * A `blob_references` row carrying only what the lens reads.
 *
 * Offsets and lexical features are quiet defaults: the edge lens reads `blob`,
 * `ordinal`, `rawRef` and `syntacticForm`, and a suite that cared about another
 * column would override it visibly at the call site.
 *
 * @param fromPath - The path whose blob holds this reference
 * @param ordinal - Position among that blob's references
 * @param rawRef - The reference exactly as authored
 * @param syntacticForm - Which form it was lexed as
 * @returns The reference row
 */
function reference(
  fromPath: string,
  ordinal: number,
  rawRef: string,
  syntacticForm: ReferenceSyntacticForm = 'markdown-link',
): BlobReferenceRow {
  return {
    blob: `key:${fromPath}`,
    ordinal,
    rawRef,
    text: null,
    line: ordinal + 1,
    column: 1,
    startOffset: 0,
    endOffset: rawRef.length,
    syntacticForm,
    hasExtension: rawRef.includes('.'),
    leadingAt: rawRef.startsWith('@'),
    slashCount: [...rawRef].filter((character) => character === '/').length,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: false,
  };
}

/**
 * A projection holding only the three tables the edge lens reads.
 *
 * The other nine are empty because the lens does not read them — an assertion
 * that passed only because a fixture supplied an unrelated table would be
 * testing the fixture.
 *
 * @param paths - Root-relative paths the extent realizes
 * @param references - Every reference row, across every blob
 * @returns The projection
 */
function projectionWith(
  paths: readonly string[],
  references: readonly BlobReferenceRow[],
): Projection {
  return {
    roots: [{ id: 'root:1', path: ROOT, label: null }],
    resources: [],
    resourceRealizations: paths.map((path) => queryRealization(path)),
    resourceExtents: [],
    resourceTags: [],
    realizationConditions: [],
    resolutionContexts: [],
    zoneProvenance: [],
    blobs: [],
    blobReferences: references,
    blobSections: [],
    blobConditions: [],
  } as unknown as Projection;
}

/**
 * The single candidate a one-reference fixture produces.
 *
 * @param rawRef - The reference to resolve
 * @param paths - Paths the extent realizes, `a.md` included by default
 * @returns The one `edge_resolutions` row, or undefined when there is none
 */
function candidateFor(rawRef: string, paths: readonly string[] = [SOURCE]) {
  const projection = projectionWith(paths, [reference(SOURCE, 0, rawRef)]);
  return resolveEdges(projection, LENS).edgeResolutions[0];
}

describe('resolveEdges — an edge per admitted reference', () => {
  it('emits one edge and one candidate for a link that resolves in the corpus', () => {
    const projection = projectionWith(
      [GUIDE, DOCS_TARGET],
      [reference(GUIDE, 0, './target.md')],
    );

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      src: `id:${GUIDE}`,
      refOrdinal: 0,
      contextId: LENS.contextId,
      origin: 'authored',
    });
    expect(edgeResolutions).toHaveLength(1);
    expect(edgeResolutions[0]).toMatchObject({
      dstKind: 'resource',
      dstResource: `id:${DOCS_TARGET}`,
      dstKey: `id:${DOCS_TARGET}`,
      dstAnchor: null,
    });
  });

  it('grades nothing — tier and score stay null, so neither word loses its meaning', () => {
    const candidate = candidateFor(TARGET, [SOURCE, TARGET]);

    expect(candidate?.tier).toBeNull();
    expect(candidate?.score).toBeNull();
  });

  it('carries a fragment onto dstAnchor', () => {
    expect(candidateFor(`${TARGET}#installation`, [SOURCE, TARGET])?.dstAnchor)
      .toBe('installation');
  });

  it('resolves relative to the REFERRING file, not to the root', () => {
    const projection = projectionWith(
      ['docs/deep/guide.md', DOCS_TARGET],
      [reference('docs/deep/guide.md', 0, '../target.md')],
    );

    expect(resolveEdges(projection, LENS).edgeResolutions[0]?.dstResource)
      .toBe(`id:${DOCS_TARGET}`);
  });
});

describe('resolveEdges — a destination is not always a resource', () => {
  it('classes an external URL as external, never as a broken local link', () => {
    const candidate = candidateFor(EXTERNAL_URL);

    expect(candidate?.dstKind).toBe('external');
    expect(candidate?.dstResource).toBeNull();
    expect(candidate?.dstKey).toBe(EXTERNAL_URL);
  });

  it('classes a target the corpus does not realize as out-of-corpus, NOT as dead', () => {
    const candidate = candidateFor(MISSING_HREF);

    expect(candidate?.dstKind).toBe(OUT_OF_CORPUS);
    expect(candidate?.dstResource).toBeNull();
    expect(candidate?.dstKey).toBe('missing.md');
  });

  it('classes a target above the root as out-of-corpus, keyed on its escaping path', () => {
    const candidate = candidateFor('../outside/notes.md');

    expect(candidate?.dstKind).toBe(OUT_OF_CORPUS);
    expect(candidate?.dstKey).toBe('../outside/notes.md');
  });

  it('separates external from outside-the-corpus by CLASS, which one null could not', () => {
    const projection = projectionWith(
      [SOURCE],
      [
        reference(SOURCE, 0, EXTERNAL_URL),
        reference(SOURCE, 1, MISSING_HREF),
      ],
    );

    const kinds = resolveEdges(projection, LENS).edgeResolutions.map((row) => row.dstKind);

    expect(kinds).toEqual(['external', OUT_OF_CORPUS]);
  });
});

describe('resolveEdges — an edge with no candidate is a real state', () => {
  it('emits the edge and NO candidate when the token names no file', () => {
    const projection = projectionWith([SOURCE], [reference(SOURCE, 0, '#section-only')]);

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    expect(edges).toHaveLength(1);
    expect(edgeResolutions).toHaveLength(0);
  });
});

describe('resolveEdges — the authored-only policy', () => {
  it('admits the three authored forms', () => {
    expect([...AUTHORED_EDGE_FORMS].sort((left, right) => left.localeCompare(right)))
      .toEqual(['html-link', 'markdown-link', 'markdown-link-reference']);
  });

  it('EXCLUDES markdown-definition — the edge belongs to the use, not the definition', () => {
    expect(AUTHORED_EDGE_FORMS.has('markdown-definition')).toBe(false);

    const projection = projectionWith(
      [SOURCE, TARGET],
      [
        reference(SOURCE, 0, TARGET, 'markdown-link-reference'),
        reference(SOURCE, 1, TARGET, 'markdown-definition'),
      ],
    );

    // One edge, not two: counting the definition too would double-count every
    // inbound reference-style link.
    expect(resolveEdges(projection, LENS).edges).toHaveLength(1);
  });

  it('admits no lexer-derived token under authored-only, whatever it looks like', () => {
    const projection = projectionWith(
      [SOURCE, TARGET],
      [
        reference(SOURCE, 0, TARGET, 'bare-token'),
        reference(SOURCE, 1, `@${TARGET}`, 'at-prefixed'),
      ],
    );

    expect(resolveEdges(projection, LENS).edges).toHaveLength(0);
  });

  it('reads references only from the lens\'s own extent', () => {
    const projection = projectionWith([SOURCE], [reference(SOURCE, 0, SOURCE)]);
    const otherExtent = { ...LENS, extentContextId: 'extent:dist' };

    expect(resolveEdges(projection, otherExtent).edges).toHaveLength(0);
  });

  it('returns nothing for a projection with no root, rather than guessing one', () => {
    const projection = projectionWith([SOURCE], [reference(SOURCE, 0, SOURCE)]);
    const rootless = { ...projection, roots: [] } as unknown as Projection;

    expect(resolveEdges(rootless, LENS)).toEqual({ edges: [], edgeResolutions: [] });
  });
});

describe('resolveEdges — every emitted row satisfies the shipped schema', () => {
  const projection = projectionWith(
    [GUIDE, DOCS_TARGET],
    [
      reference(GUIDE, 0, './target.md#anchor'),
      reference(GUIDE, 1, `${EXTERNAL_URL}#f`),
      reference(GUIDE, 2, MISSING_HREF),
      reference(GUIDE, 3, '#anchor-only'),
    ],
  );
  const relation = resolveEdges(projection, LENS);

  it('emits four edges and three candidates — the anchor-only token has no destination', () => {
    expect(relation.edges).toHaveLength(4);
    expect(relation.edgeResolutions).toHaveLength(3);
  });

  it('validates every edge row', () => {
    for (const row of relation.edges) {
      expect(EdgeRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('validates every candidate row', () => {
    for (const row of relation.edgeResolutions) {
      expect(EdgeResolutionRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('keys each edge uniquely on (src, refOrdinal, contextId)', () => {
    const keys = relation.edges.map(
      (row) => `${row.src} ${String(row.refOrdinal)} ${row.contextId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
