import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

import {
  AUTHORED_EDGE_FORMS,
  buildReferenceIndex,
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
/** A target at the corpus root, sharing a basename with {@link DOCS_TARGET}. */
const ROOT_TARGET = 'target.md';
/** A target beside {@link GUIDE}. */
const DOCS_TARGET = 'docs/target.md';
/** The destination class for anything the corpus does not contain but that is a path. */
const OUT_OF_CORPUS = 'out-of-corpus';
/** An external URL used across the classification assertions. */
const EXTERNAL_URL = 'https://example.com/x';
/** A relative href naming a file the fixture corpus deliberately does not realize. */
const MISSING_HREF = './missing.md';
/** A sibling-relative href, whose resolution depends on the referring file's directory. */
const SIBLING_TARGET_HREF = './target.md';

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
    // 🚨 Membership, not the realization's `extentId`, is what puts an identity
    // in a lens's extent — and a fixture that left this empty would make every
    // assertion below vacuous rather than failing loudly. A closure extent has
    // memberships and NO realizations of its own; see `sourceRealizations`.
    resourceExtents: paths.map((path) => ({ resourceId: `id:${path}`, extentId: LENS.extentContextId })),
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
      [reference(GUIDE, 0, SIBLING_TARGET_HREF)],
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

  it('picks the LOWEST PATH as the resolution base, not whichever row came first', () => {
    // The choice is a resolution BASE, not a cosmetic tie-break. An identity
    // realized at both `a.md` and `docs/link.md` resolves `./target.md` to
    // `target.md` or `docs/target.md` depending purely on the row picked — two
    // different destinations, one of them wrong. And projection order is
    // genuinely unstable: `selectExtentSql` carries no ORDER BY, so a rehydrated
    // projection returns primary-key order while a derived one returns emission
    // order. "First wins" would give one corpus two answers.
    //
    // An earlier version of this test used an EXTERNAL href and asserted only
    // the edge COUNT. It was vacuous along this axis: an external destination
    // does not depend on the referring path, so it held under first-wins,
    // last-wins, or any-wins.
    const symlinked = {
      ...queryRealization('docs/link.md'),
      resourceId: `id:${SOURCE}`,
      contentKey: `key:${SOURCE}`,
    };
    // BOTH bases resolve, to DIFFERENT files: `./target.md` is `target.md` from
    // the root and `docs/target.md` from `docs/`. That is what makes the
    // assertion discriminating — if either base failed to resolve, the row would
    // be out-of-corpus and the test could not say which base was used.
    const projection = {
      ...projectionWith([SOURCE, ROOT_TARGET, DOCS_TARGET], [reference(SOURCE, 0, SIBLING_TARGET_HREF)]),
      // The symlink row FIRST, so "first wins" would resolve from `docs/`.
      resourceRealizations: [
        symlinked,
        queryRealization(SOURCE),
        queryRealization(ROOT_TARGET),
        queryRealization(DOCS_TARGET),
      ],
    } as unknown as Projection;

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    expect(edges).toHaveLength(1);
    // `a.md` sorts below `docs/link.md`, so the root is the base and the target
    // is `target.md` — NOT `docs/target.md`, which is what first-wins gives.
    expect(edgeResolutions[0]?.dstResource).toBe(`id:${ROOT_TARGET}`);
  });

  it("reads a member through its OWN extent, not another extent's bytes", () => {
    // zones.md section 4: one identity has several realizations, and the
    // packager REWRITES content — a `dist` realization has different bytes and a
    // different path. A filesystem lens reading those would resolve links from
    // `dist/skills/x/` and report out-of-corpus for links that are fine in
    // source, manufacturing exactly the divergence section 2 says a lens exists
    // to expose. Dropping the extent filter entirely (rather than replacing it
    // with a preference) is what made that reachable.
    // 🪤 The packaged path must sort BELOW `a.md`, or the path tie-break alone
    // picks the source row and the extent preference is never consulted — which
    // is exactly how the first version of this test passed with the preference
    // deleted. `0-dist/...` sorts before `a.md`; `dist/...` does NOT.
    const packaged = {
      ...queryRealization('0-dist/skills/x/a.md'),
      resourceId: `id:${SOURCE}`,
      contentKey: 'key:packaged',
      extentId: 'extent:dist',
    };
    const projection = {
      ...projectionWith([SOURCE, TARGET], [reference(SOURCE, 0, './b.md')]),
      // First in order AND lowest by path, so ONLY the extent preference can
      // stop the packaged row winning.
      resourceRealizations: [packaged, queryRealization(SOURCE), queryRealization(TARGET)],
    } as unknown as Projection;

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    expect(edges).toHaveLength(1);
    // Read through `a.md`, so `./b.md` is the corpus's own `b.md`.
    expect(edgeResolutions[0]?.dstResource).toBe(`id:${TARGET}`);
  });

  it('classes each edge external or local_file by its own token', () => {
    // Reverting `kind` to the constant `'local_file'` left EVERY test passing:
    // no assertion named the column, and `EdgeKindSchema` is an OPEN string, so
    // schema validation accepts `local_file` for an https URL. An
    // open-vocabulary column cannot be guarded by schema validation — it needs a
    // value assertion. The `dstKind` tests guard a different call site of the
    // same regex.
    const projection = projectionWith(
      [SOURCE],
      [reference(SOURCE, 0, EXTERNAL_URL), reference(SOURCE, 1, SOURCE)],
    );

    expect(resolveEdges(projection, LENS).edges.map((edge) => edge.kind))
      .toEqual(['external', 'local_file']);
  });

  it('classes a fragment-only reference as an ANCHOR, not as a local_file', () => {
    // `#section-only` names no file, so counting it under `local_file` inflates
    // every `COUNT(*) WHERE kind = 'local_file'`. Measured on this repository,
    // 159 of 988 filesystem-lens edges — 16% — are fragment-only, and all of
    // them classed as files. `anchor` is already a documented member of
    // `EdgeKindSchema`'s open vocabulary and had no producer.
    const projection = projectionWith(
      [SOURCE],
      [reference(SOURCE, 0, '#section-only'), reference(SOURCE, 1, SOURCE)],
    );

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    expect(edges.map((edge) => edge.kind)).toEqual(['anchor', 'local_file']);
    // ⛔ SCOPE: an anchor edge still produces NO candidate. Whether a
    // same-document anchor should resolve to its own source is a DEFERRED
    // design decision, and a `kind` change must not smuggle it in — only the
    // `a.md` reference contributes a candidate here.
    expect(edgeResolutions).toHaveLength(1);
    expect(edgeResolutions[0]?.refOrdinal).toBe(1);
  });

  it('reads an extent whose members are REALIZED BY ANOTHER PASS', () => {
    // 🚨 The regression this exists for. A closure extent contributes
    // memberships over identities the filesystem extent already realized, so
    // its realizations carry someone else's `extentId`. Sourcing by
    // `realization.extentId` returned ZERO edges for it — measured on this
    // repository, 160 members and no rows — an empty relation shaped exactly
    // like a valid answer.
    const projection = {
      ...projectionWith([SOURCE, TARGET], [reference(SOURCE, 0, TARGET)]),
      resourceRealizations: [SOURCE, TARGET].map((path) => ({
        ...queryRealization(path),
        extentId: 'extent:filesystem',
      })),
      resourceExtents: [SOURCE, TARGET].map((path) => ({
        resourceId: `id:${path}`,
        extentId: LENS.extentContextId,
      })),
    } as unknown as Projection;

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    expect(edges).toHaveLength(1);
    // And it RESOLVES: the target is a member, so it is a resource rather than
    // being misreported as out-of-corpus.
    expect(edgeResolutions[0]?.dstKind).toBe('resource');
    expect(edgeResolutions[0]?.dstResource).toBe(`id:${TARGET}`);
  });

  it('treats a realized NON-member as out-of-corpus, since the extent is the corpus', () => {
    // The other half of the same rule: membership decides scope, so a file the
    // tree realizes but this lens's extent does not claim is outside it.
    const projection = {
      ...projectionWith([SOURCE, TARGET], [reference(SOURCE, 0, TARGET)]),
      resourceExtents: [{ resourceId: `id:${SOURCE}`, extentId: LENS.extentContextId }],
    } as unknown as Projection;

    expect(resolveEdges(projection, LENS).edgeResolutions[0]?.dstKind).toBe('out-of-corpus');
  });

  it('RESOLVES a link to a member with no parsed bytes — an image is a real target', () => {
    // 🚨 The regression this pins, which only re-running the corpus analytics
    // caught. Excluding `contentKey === null` rows from the path index reported
    // every link to an image, a PDF or any other unparsed member as
    // out-of-corpus. On the primary adopter that moved the out-of-corpus count
    // from 51 to 119 — a number that looks plausible and is wrong.
    //
    // 🔑 "Can I read references OUT of this?" needs bytes. "Can a reference
    // point AT this?" does not. Only the first filter belongs on the source set.
    const image = { ...queryRealization('img/diagram.png'), contentKey: null };
    const projection = {
      ...projectionWith([SOURCE], [reference(SOURCE, 0, './img/diagram.png')]),
      resourceRealizations: [queryRealization(SOURCE), image],
      resourceExtents: [SOURCE, 'img/diagram.png'].map((path) => ({
        resourceId: `id:${path}`,
        extentId: LENS.extentContextId,
      })),
    } as unknown as Projection;

    const { edges, edgeResolutions } = resolveEdges(projection, LENS);

    // One edge, from the only member that HAS bytes to read.
    expect(edges).toHaveLength(1);
    expect(edgeResolutions[0]?.dstKind).toBe('resource');
    expect(edgeResolutions[0]?.dstResource).toBe('id:img/diagram.png');
  });

  it('gives the SAME answer when every input table arrives in a different order', () => {
    // 🚨 The property the determinism fix exists for, and the one nothing
    // pinned. The tests around this one refute "first in projection order
    // wins" — but reverting `rows.sort(byPath)` to `rows.reverse()` passed all
    // of them, because last-wins is just as projection-order-dependent as
    // first-wins and they only ever saw one order. The assertion has to be a
    // COMPARISON OF TWO ORDERS, not a claim about one.
    //
    // It covers three separate order dependencies at once: the realization
    // sort, the member-key sort, and `groupReferencesByBlob`, which did not
    // sort at all while its docstring said it returned ordinal order.
    const paths = [SOURCE, TARGET, ROOT_TARGET, DOCS_TARGET, GUIDE];
    const references = [
      reference(SOURCE, 0, './b.md'),
      reference(SOURCE, 1, EXTERNAL_URL),
      reference(SOURCE, 2, MISSING_HREF),
      reference(GUIDE, 0, SIBLING_TARGET_HREF),
      reference(GUIDE, 1, '../b.md'),
    ];
    // A second realization for one identity, so the base CHOICE is exercised
    // rather than merely the row order.
    // 🪤 It must sit in a DIFFERENT DIRECTORY from `a.md`, or the test is
    // vacuous: an alias beside the source resolves every relative href to the
    // same file, so the two orders agree no matter which base is picked. The
    // first version of this test used `zz-alias.md` at the root and PASSED with
    // `rows.sort(byPath)` reverted to `rows.reverse()`. From `docs/` the two
    // bases disagree — `./b.md` is `b.md` from the root and out-of-corpus from
    // `docs/` — which is what makes the comparison discriminating.
    const alias = { ...queryRealization('docs/zz-alias.md'), resourceId: `id:${SOURCE}`, contentKey: `key:${SOURCE}` };

    const build = (flip: boolean): Projection => {
      const base = projectionWith(
        flip ? [...paths].reverse() : paths,
        flip ? [...references].reverse() : references,
      );
      const realizations = [...base.resourceRealizations, alias];
      return {
        ...base,
        resourceRealizations: flip ? [...realizations].reverse() : realizations,
      } as unknown as Projection;
    };

    const forward = resolveEdges(build(false), LENS);
    const reversed = resolveEdges(build(true), LENS);

    // Non-vacuity: the fixture must actually produce rows, or two empty
    // relations would compare equal and prove nothing.
    expect(forward.edges.length).toBeGreaterThan(0);
    expect(forward.edgeResolutions.length).toBeGreaterThan(0);
    expect(reversed.edges).toEqual(forward.edges);
    expect(reversed.edgeResolutions).toEqual(forward.edgeResolutions);
  });

  it('breaks a tie that `localeCompare` would not, so the comparator itself is pinned', () => {
    // 🚨 The test that makes the choice of comparator load-bearing. Swapping
    // code-point order back to `localeCompare` passes every other test in this
    // file, because the two agree on ASCII — so nothing constrained a
    // comparator whose answer depends on `LANG` and on the JS runtime.
    //
    // These two directory names are canonically equivalent (NFC `é` versus NFD
    // `e` + combining acute), which `localeCompare` reports as EQUAL. A tie
    // falls through to `Array#sort`'s stability, i.e. to projection order —
    // the exact dependence the sort exists to remove. Code-point order has no
    // ties between distinct strings.
    //
    // 🪤 Built with `String.fromCodePoint`, never typed as an escape: a `\u`
    // escape written into a source file becomes a real byte on the way in,
    // which makes the file read as binary and the two spellings visually
    // identical in review.
    const nfc = `caf${String.fromCodePoint(0xe9)}`;
    const nfd = `cafe${String.fromCodePoint(0x301)}`;
    expect(nfc.localeCompare(nfd)).toBe(0);
    expect(nfc).not.toBe(nfd);

    const build = (flip: boolean): Projection => {
      const base = projectionWith([SOURCE, `${nfc}/target.md`, `${nfd}/target.md`], [
        reference(SOURCE, 0, SIBLING_TARGET_HREF),
      ]);
      // One identity, realized in both directories — so which one wins decides
      // which `target.md` the reference resolves to.
      const aliases = [`${nfc}/link.md`, `${nfd}/link.md`].map((path) => ({
        ...queryRealization(path),
        resourceId: `id:${SOURCE}`,
        contentKey: `key:${SOURCE}`,
      }));
      return {
        ...base,
        resourceRealizations: [
          ...base.resourceRealizations.filter((row) => row.path !== SOURCE),
          ...(flip ? [...aliases].reverse() : aliases),
        ],
      } as unknown as Projection;
    };

    const forward = resolveEdges(build(false), LENS).edgeResolutions;
    const reversed = resolveEdges(build(true), LENS).edgeResolutions;

    expect(forward).toHaveLength(1);
    // NFD sorts below NFC by code point ('e' < 'é'), the same way every time.
    expect(forward[0]?.dstResource).toBe(`id:${nfd}/target.md`);
    expect(reversed).toEqual(forward);
  });

  it('answers identically whether or not a caller supplies the shared index', () => {
    // 🪤 `options.referencesByBlob` is a defaulted parameter — `?? group(...)`
    // — which is this repo's classic silent no-op: deleting the argument at the
    // only call site produced byte-identical output and moved nothing but wall
    // time. Nothing passed the option anywhere, so the shared-index path was
    // entirely unexecuted by the suite.
    //
    // This does not measure the saving (that is the lab's job); it pins that
    // the shared path and the private one are the SAME answer, which is the
    // property that makes the optimisation safe to keep.
    const projection = projectionWith(
      [SOURCE, TARGET],
      [reference(SOURCE, 0, './b.md'), reference(SOURCE, 1, EXTERNAL_URL)],
    );

    const shared = resolveEdges(projection, LENS, {
      referencesByBlob: buildReferenceIndex(projection),
    });
    const private_ = resolveEdges(projection, LENS);

    expect(shared.edges.length).toBeGreaterThan(0);
    expect(shared).toEqual(private_);
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
