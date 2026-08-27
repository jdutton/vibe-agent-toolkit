/**
 * The reuse rule — whether a stored extent answers *this* run's question, and
 * what a hit is allowed to hand back.
 *
 * `ExtentKey` names a tree, not a question. Two commands over one tree ask
 * different things of it, so every assertion here is about the gap between
 * "the store holds rows under this key" and "the store holds the answer this
 * run asked for". The two failure directions are equally bad and are tested
 * apart from each other:
 *
 * - **accepting too little** — a stored extent that does cover the run is
 *   rejected, and the cache silently never hits;
 * - **accepting too much** — a stored extent that covers a *different*
 *   question is served, and the run receives a confidently wrong membership.
 *
 * Every fixture is built inside its own test. The functions under test do not
 * mutate, but a shared bundle is how a suite starts depending on test order,
 * and "passes in isolation" is a signature rather than an exoneration.
 */

import { compareCodeUnits, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  assembleProjection,
  blobFactsCover,
  emptyBlobRows,
  keyedContentKeys,
  selectRequestedContexts,
  selectRequestedRows,
  type RequestedContributor,
} from '../src/projection/store-hydration.js';
import type { BlobScopedRows, ExtentScopedRows } from '../src/projection/store.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';
import type { BlobConditionRow, BlobRow } from '../src/schemas/projection-blobs.js';
import {
  CONDITION_WITHOUT_REFERENCE,
  type ResourceRealizationRow,
  type ResourceRow,
  type ResourceTagRow,
} from '../src/schemas/projection-resources.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';
import type { ResolutionContextRow, ZoneProvenanceRow } from '../src/schemas/projection-zones.js';

/** The corpus root this run is over. */
const ROOT_ID = 'root-main';

/**
 * A second root under the same bundle.
 *
 * Contrived on purpose: a store keys extents on `(rootId, treeHash)`, so one
 * bundle rarely spans two roots. But a `roots` row is kept when it is this run's
 * root **or** a kept context names it, and with a single root in the fixture the
 * two disjuncts are indistinguishable — an implementation that ignored the
 * second half entirely would still be green.
 */
const ROOT_SIBLING = 'root-sibling';

const CTX_FILESYSTEM = 'ctx-filesystem';
const CTX_ALPHA = 'ctx-skill-alpha';
const CTX_BETA = 'ctx-skill-beta';
const CTX_SIBLING = 'ctx-sibling-filesystem';

const FILESYSTEM_CONTRIBUTOR = 'vat:filesystem';
const ALPHA_CONTRIBUTOR = 'inventory-extent:skills/alpha/SKILL.md';
const BETA_CONTRIBUTOR = 'inventory-extent:skills/beta/SKILL.md';
const SIBLING_CONTRIBUTOR = 'vat:filesystem-sibling';

/**
 * The declaration the closure primitive is handed.
 *
 * A generic contributor plus a declaration is what makes the parameter set
 * load-bearing: the id alone says which skill, and only the declaration says
 * which question about it.
 */
const CLOSURE_PARAMETERS: JsonValue = { follow: ['link', 'import'], limits: { maxDepth: 2, maxNodes: 9 } };

/** The same declaration, both of its objects assembled in the opposite key order. */
const CLOSURE_PARAMETERS_REORDERED: JsonValue = { limits: { maxNodes: 9, maxDepth: 2 }, follow: ['link', 'import'] };

/** A genuinely different declaration — one `maxDepth` deeper. */
const CLOSURE_PARAMETERS_DEEPER: JsonValue = { follow: ['link', 'import'], limits: { maxDepth: 3, maxNodes: 9 } };

/** The same declaration with its one array reversed. Array order is data, not key order. */
const CLOSURE_PARAMETERS_ARRAY_REVERSED: JsonValue = {
  follow: ['import', 'link'],
  limits: { maxDepth: 2, maxNodes: 9 },
};

const RES_SHARED = 'res-shared';
const RES_ALPHA = 'res-alpha-only';
const RES_BETA = 'res-beta-only';

/**
 * An identity with a membership and no realization.
 *
 * `PackageExtentContributor` mints exactly this for a dependency declared but
 * absent from `node_modules` — "membership is knowledge; realization is
 * presence" — so reachability has to follow memberships and not only
 * realizations, or a cache hit loses every declared-but-absent entity the
 * populate path would have carried.
 */
const RES_DECLARED = 'res-declared-not-present';

const SHARED_PATH = 'docs/a.md';
const ALPHA_PATH = 'skills/alpha/SKILL.md';
const BETA_PATH = 'skills/beta/SKILL.md';
const FILE_KIND = 'file';
const SKILL_KIND = 'skill';

/** The columns of a realization that say whether it has bytes, and where they are. */
type ContentColumns = Pick<ResourceRealizationRow, 'contentKey' | 'contentState'>;

/**
 * A syntactically real content key — `<parserKind>.<sha256>`, the one shape
 * `CONTENT_KEY_PATTERN` accepts. Derived from a seed so two fixtures cannot
 * accidentally share one.
 *
 * @param seed - Distinguishes this key from every other in the file
 * @returns A key of the form `markdown.<64 hex digits>`
 */
function contentKey(seed: number): string {
  return `markdown.${seed.toString(16).padStart(64, '0')}`;
}

const KEY_SHARED = contentKey(1);
const KEY_ALPHA = contentKey(2);
const KEY_BETA = contentKey(3);

/**
 * The content columns of a realization whose bytes were read and hashed.
 *
 * @param key - The content key those bytes produced
 * @returns The `keyed`/non-null pair the row schema pins together
 */
function keyedContent(key: string): ContentColumns {
  return { contentKey: key, contentState: 'keyed' };
}

/** The content columns of a path with no bytes to key at all — a directory, here. */
const NO_CONTENT: ContentColumns = { contentKey: null, contentState: 'none' };

/**
 * One extent's `resolution_contexts` row.
 *
 * `extentContextId` is null because an extent is its own base, and `role` is
 * null because none of these is `kind: 'tree'`. Both are superRefine'd, so a
 * fixture that got them wrong would fail the schema check at the foot of this
 * file rather than quietly standing in for a real row.
 *
 * @param contextId - The context's id
 * @param kind - Its open-vocabulary zone kind
 * @param rootId - The corpus root it is scoped to
 * @returns The row
 */
function extentContext(contextId: string, kind: string, rootId: string): ResolutionContextRow {
  return { contextId, species: 'extent', kind, rootId, extentContextId: null, role: null };
}

/**
 * One `zone_provenance` row — the record of which contributor ran under which
 * parameters, and so the only thing in a stored extent that knows what was
 * asked of it.
 *
 * @param contextId - The context the contributor declared
 * @param contributorId - Which contributor
 * @param parameterSet - The parameters it ran under, verbatim
 * @returns The row
 */
function provenance(contextId: string, contributorId: string, parameterSet: JsonValue): ZoneProvenanceRow {
  return { contextId, contributorId, parameterSet, extentDigest: `digest-of-${contextId}` };
}

/**
 * One `resource_realizations` row — one path in one extent.
 *
 * The path-shaped columns are derived rather than passed, because no assertion
 * in this file reads them and an inconsistent set would be a fixture that no
 * contributor could have emitted.
 *
 * @param resourceId - The identity realized here
 * @param extentId - The extent this path was observed in
 * @param path - Root-relative, forward-slash separated
 * @param content - Whether this realization has bytes, and their key
 * @returns The row
 */
function realization(
  resourceId: string,
  extentId: string,
  path: string,
  content: ContentColumns,
): ResourceRealizationRow {
  // Root-relative projection paths are forward-slash by schema; naming the
  // normalizer is what makes the split legal on Windows as well as correct here.
  const segments = toForwardSlash(path).split('/');
  return {
    resourceId,
    extentId,
    path,
    pathLower: path.toLowerCase(),
    basenameLower: (segments.at(-1) ?? path).toLowerCase(),
    dir: segments.slice(0, -1).join('/'),
    depth: segments.length - 1,
    ext: '.md',
    // Every fixture path here is markdown — the hardcoded `ext` above says so —
    // so this is what `mimeTypeForPath` would answer, not a filler value.
    mime: 'text/markdown',
    ...content,
    mtime: new Date('2026-01-01T00:00:00.000Z'),
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };
}

/**
 * One `resources` row.
 *
 * @param resourceId - The identity
 * @param kind - Its open-vocabulary entity kind
 * @param observed - False for a synthetic entity nothing has ever seen
 * @returns The row
 */
function resource(resourceId: string, kind: string, observed: boolean): ResourceRow {
  return { resourceId, kind, origin: 'fixture', observed, fromEnumeration: observed, vatId: null };
}

/**
 * One `resource_tags` row — a boolean-presence tag, which is why `value` is null.
 *
 * @param resourceId - The identity tagged
 * @param name - The tag
 * @returns The row
 */
function resourceTag(resourceId: string, name: string): ResourceTagRow {
  return { resourceId, tag: name, value: null, source: 'fixture' };
}

/**
 * The stored bundle every `selectRequestedRows` case narrows.
 *
 * It models the situation the module was written for: `vat inventory` wrote the
 * filesystem extent **and** one closure extent per skill under this key, and a
 * later `vat resources scan` declares the filesystem extent alone.
 *
 * @returns The eight extent-scoped tables
 */
function storedExtent(): ExtentScopedRows {
  return {
    roots: [
      { id: ROOT_ID, path: '/vat-corpus/main' },
      { id: ROOT_SIBLING, path: '/vat-corpus/sibling' },
    ],
    resources: [
      resource(RES_SHARED, FILE_KIND, true),
      resource(RES_ALPHA, FILE_KIND, true),
      resource(RES_BETA, FILE_KIND, true),
      resource(RES_DECLARED, 'plugin', false),
    ],
    resourceRealizations: [
      realization(RES_SHARED, CTX_FILESYSTEM, SHARED_PATH, keyedContent(KEY_SHARED)),
      // The same file again, through a skill's closure extent. This row is the
      // whole reason a hit has to be narrowed: `buildResourcePopulation` walks
      // `resourceRealizations` with no extent filter, so handing it back to a
      // filesystem-only run doubles that run's population.
      realization(RES_SHARED, CTX_ALPHA, SHARED_PATH, keyedContent(KEY_SHARED)),
      realization(RES_ALPHA, CTX_ALPHA, ALPHA_PATH, keyedContent(KEY_ALPHA)),
      realization(RES_BETA, CTX_BETA, BETA_PATH, keyedContent(KEY_BETA)),
    ],
    resourceExtents: [
      { resourceId: RES_SHARED, extentId: CTX_FILESYSTEM },
      { resourceId: RES_SHARED, extentId: CTX_ALPHA },
      { resourceId: RES_ALPHA, extentId: CTX_ALPHA },
      { resourceId: RES_BETA, extentId: CTX_BETA },
      { resourceId: RES_DECLARED, extentId: CTX_FILESYSTEM },
    ],
    resourceTags: [
      resourceTag(RES_SHARED, 'documentation'),
      resourceTag(RES_BETA, 'documentation'),
      resourceTag(RES_DECLARED, 'declared-only'),
    ],
    realizationConditions: [
      {
        extentId: CTX_BETA,
        path: BETA_PATH,
        code: 'REALIZATION_PATH_COLLISION',
        severity: 'error',
        message: 'two identities flattened to one bundled path',
        resourceId: RES_BETA,
        ...CONDITION_WITHOUT_REFERENCE,
      },
    ],
    resolutionContexts: [
      extentContext(CTX_FILESYSTEM, 'filesystem', ROOT_ID),
      extentContext(CTX_ALPHA, SKILL_KIND, ROOT_ID),
      extentContext(CTX_BETA, SKILL_KIND, ROOT_ID),
      extentContext(CTX_SIBLING, 'filesystem', ROOT_SIBLING),
    ],
    zoneProvenance: [
      provenance(CTX_FILESYSTEM, FILESYSTEM_CONTRIBUTOR, null),
      provenance(CTX_ALPHA, ALPHA_CONTRIBUTOR, CLOSURE_PARAMETERS),
      provenance(CTX_BETA, BETA_CONTRIBUTOR, CLOSURE_PARAMETERS),
      provenance(CTX_SIBLING, SIBLING_CONTRIBUTOR, null),
    ],
  };
}

/** What `vat resources scan` registers against the bundle above. */
const FILESYSTEM_ONLY: readonly RequestedContributor[] = [{ id: FILESYSTEM_CONTRIBUTOR, parameterSet: null }];

/**
 * A sorted copy, because the selection walks a `Set` and its order is not part
 * of the contract. `undefined` survives, so this helper can never turn a miss
 * into an empty hit.
 *
 * @param ids - What `selectRequestedContexts` returned
 * @returns The same answer, sorted when there is one
 */
function sortedIds(ids: readonly string[] | undefined): readonly string[] | undefined {
  return ids === undefined ? undefined : [...ids].sort(compareCodeUnits);
}

/** A sorted copy of a key list, so two derived lists compare without ordering noise. */
function sortedKeys(keys: readonly string[]): readonly string[] {
  return [...keys].sort(compareCodeUnits);
}

/**
 * The table names of one scope, read out of the registry rather than listed.
 *
 * @param scope - Which half of the projection
 * @returns Its table names
 */
function tableKeysOfScope(scope: 'blob' | 'extent'): readonly string[] {
  return Object.values(PROJECTION_TABLES)
    .filter((spec) => spec.scope === scope)
    .map((spec) => spec.key);
}

/**
 * A `blobs` row. Every measure is zero: only the key participates in coverage.
 *
 * @param key - The content key
 * @returns The row
 */
function blobRow(key: string): BlobRow {
  return {
    contentKey: key,
    bytes: 0,
    encoding: 'utf-8',
    encodingSource: 'assumed',
    replacementCharacters: 0,
    tokenEstimate: 0,
    frontmatter: null,
    frontmatterError: null,
    wordCount: 0,
    proseCodeUnits: 0,
    codeBlockCodeUnits: 0,
    linkCount: 0,
    headingCount: 0,
    sectionCount: 0,
  };
}

/**
 * A `blob_conditions` row — what the derivation stage records **instead of** a
 * `blobs` row when it declines to parse.
 *
 * @param key - The content key it declined to parse
 * @returns The row
 */
function blobConditionRow(key: string): BlobConditionRow {
  return { blob: key, code: 'BLOB_BINARY', severity: 'info', message: 'NUL byte within the sniff window', line: null };
}

/**
 * A blob-scoped bundle carrying the given rows and nothing else.
 *
 * @param rows - What the store holds
 * @param rows.blobs - `blobs` rows
 * @param rows.blobConditions - `blob_conditions` rows
 * @returns The four blob-scoped tables
 */
function blobFacts(rows: { blobs?: readonly BlobRow[]; blobConditions?: readonly BlobConditionRow[] }): BlobScopedRows {
  return { ...emptyBlobRows(), ...rows };
}

/**
 * An extent-scoped bundle holding only realizations — all
 * {@link keyedContentKeys} reads.
 *
 * @param rows - The realizations
 * @returns The eight tables, seven of them empty
 */
function extentWithRealizations(rows: readonly ResourceRealizationRow[]): ExtentScopedRows {
  return {
    roots: [],
    resources: [],
    resourceRealizations: rows,
    resourceExtents: [],
    resourceTags: [],
    realizationConditions: [],
    resolutionContexts: [],
    zoneProvenance: [],
  };
}

describe('selectRequestedContexts', () => {
  it('hits when every registered contributor already has a provenance row under the same parameter set', () => {
    const requested: readonly RequestedContributor[] = [
      { id: FILESYSTEM_CONTRIBUTOR, parameterSet: null },
      { id: ALPHA_CONTRIBUTOR, parameterSet: CLOSURE_PARAMETERS },
      { id: BETA_CONTRIBUTOR, parameterSet: CLOSURE_PARAMETERS },
    ];

    expect(sortedIds(selectRequestedContexts(storedExtent(), requested)))
      .toEqual(sortedKeys([CTX_FILESYSTEM, CTX_ALPHA, CTX_BETA]));
  });

  it('misses when a registered contributor has no provenance row, because the store answers a question this run did not ask', () => {
    // The store holds alpha and beta; this run also declared gamma. Every row it
    // holds is correct, and none of them is an answer about gamma — so serving
    // the bundle would report a population with one skill's closure missing and
    // no record anywhere that something was skipped.
    const requested: readonly RequestedContributor[] = [
      { id: FILESYSTEM_CONTRIBUTOR, parameterSet: null },
      { id: 'inventory-extent:skills/gamma/SKILL.md', parameterSet: CLOSURE_PARAMETERS },
    ];

    expect(selectRequestedContexts(storedExtent(), requested)).toBeUndefined();
  });

  it('misses when the ids match but the parameter sets differ, because one id under two declarations is two questions', () => {
    // The highest-value assertion in this file. The closure primitive is a
    // generic contributor handed a declaration, so alpha at maxDepth 2 and alpha
    // at maxDepth 3 are different questions wearing one id. Comparing ids alone
    // would serve one as the other: a smaller extent, reported as complete.
    const requested: readonly RequestedContributor[] = [
      { id: ALPHA_CONTRIBUTOR, parameterSet: CLOSURE_PARAMETERS_DEEPER },
    ];

    expect(selectRequestedContexts(storedExtent(), requested)).toBeUndefined();
  });

  it('hits when two parameter sets are deep-equal but their keys were assembled in a different order', () => {
    // The counterpart, and why the comparison canonicalizes instead of
    // stringifying: a declaration assembled by two code paths in two key orders
    // is one declaration. Without this the cache misses on every run whose
    // parameters came from a different branch — a permanently cold cache that no
    // other test in this package would ever go red over. Both nesting levels are
    // reordered, because a canonicalization that stopped at the top level would
    // pass a single-level case.
    const requested: readonly RequestedContributor[] = [
      { id: ALPHA_CONTRIBUTOR, parameterSet: CLOSURE_PARAMETERS_REORDERED },
    ];

    expect(sortedIds(selectRequestedContexts(storedExtent(), requested))).toEqual([CTX_ALPHA]);
  });

  it('misses when only an ARRAY inside the parameter set is reordered, because array order is data', () => {
    // The limit of the previous case. `follow: ['link', 'import']` and
    // `['import', 'link']` are two declarations, and a canonicalization that
    // sorted arrays as well as keys would quietly fuse them into one.
    const requested: readonly RequestedContributor[] = [
      { id: ALPHA_CONTRIBUTOR, parameterSet: CLOSURE_PARAMETERS_ARRAY_REVERSED },
    ];

    expect(selectRequestedContexts(storedExtent(), requested)).toBeUndefined();
  });

  it('returns an empty array, and NOT undefined, for a run that registered no contributors', () => {
    // The distinction is load-bearing: `undefined` is the miss signal, and a run
    // asking for no contexts is trivially satisfied by any stored extent. An
    // implementation that collapsed the two would read "nothing to ask" as
    // "cache miss" and re-populate for nothing.
    const selected = selectRequestedContexts(storedExtent(), []);

    expect(selected).toEqual([]);
    expect(selected).not.toBeUndefined();
  });

  it('returns only the requested contexts when the store holds a strict superset', () => {
    // `vat inventory` wrote four contexts; `vat resources scan` asks for one.
    // That is a hit, and it is a hit for exactly one context.
    expect(sortedIds(selectRequestedContexts(storedExtent(), FILESYSTEM_ONLY))).toEqual([CTX_FILESYSTEM]);
  });

  it('does not read an empty parameter set as the same question as no parameter set', () => {
    // `populate()` records `null` for a contributor given no parameters. `{}` is
    // a declaration that happens to be empty, and a normalization folding the two
    // together would be a step back toward the id-only comparison this function
    // exists to avoid.
    const requested: readonly RequestedContributor[] = [{ id: FILESYSTEM_CONTRIBUTOR, parameterSet: {} }];

    expect(selectRequestedContexts(storedExtent(), requested)).toBeUndefined();
  });
});

describe('selectRequestedRows', () => {
  it('drops another command\'s contexts, so a filesystem-only run never inherits a skill closure\'s re-realization of the same file', () => {
    // `buildResourcePopulation` walks `resourceRealizations` with no extent
    // filter at all, so a superset hydration is not a tidiness question: the run
    // would see `docs/a.md` twice and report a population the populate path
    // could never have produced.
    const selected = selectRequestedRows(storedExtent(), { contexts: [CTX_FILESYSTEM], rootId: ROOT_ID });

    expect(selected.resourceRealizations.map((row) => row.extentId)).toEqual([CTX_FILESYSTEM]);
    expect(selected.resourceExtents.map((row) => row.extentId)).toEqual([CTX_FILESYSTEM, CTX_FILESYSTEM]);
    expect(selected.resolutionContexts.map((row) => row.contextId)).toEqual([CTX_FILESYSTEM]);
    expect(selected.zoneProvenance.map((row) => row.contextId)).toEqual([CTX_FILESYSTEM]);
    // The condition is a fact about the beta closure's view of a path, not about
    // the tree, so it leaves with its context.
    expect(selected.realizationConditions).toEqual([]);
  });

  it('keeps an identity and its tags only when a kept realization or membership names it', () => {
    // The three context-less tables are recovered by reachability, not copied.
    // `res-beta-only` and its tag are reachable ONLY from the dropped beta
    // context, and `resources` carries no extent column, so a hit that copied
    // them would hand the run an identity that nothing it can see accounts for —
    // and nothing downstream is positioned to filter it out later.
    const selected = selectRequestedRows(storedExtent(), { contexts: [CTX_FILESYSTEM], rootId: ROOT_ID });

    expect(sortedKeys(selected.resources.map((row) => row.resourceId)))
      .toEqual(sortedKeys([RES_SHARED, RES_DECLARED]));
    expect(sortedKeys(selected.resourceTags.map((row) => row.resourceId)))
      .toEqual(sortedKeys([RES_SHARED, RES_DECLARED]));
  });

  it('keeps an identity reachable from a membership alone, with no realization in any kept context', () => {
    // "Membership is knowledge; realization is presence." A dependency declared
    // but absent from `node_modules` is a `resources` row with a membership and
    // no realization, so a reachability rule that followed realizations only
    // would drop every declared-but-absent entity on a cache hit while the
    // populate path kept it.
    const selected = selectRequestedRows(storedExtent(), { contexts: [CTX_FILESYSTEM], rootId: ROOT_ID });

    expect(selected.resourceRealizations.map((row) => row.resourceId)).not.toContain(RES_DECLARED);
    expect(selected.resources.map((row) => row.resourceId)).toContain(RES_DECLARED);
  });

  it('keeps this run\'s own root even when no kept context names it', () => {
    // `populate()` records the root row before any contributor runs, so a hit
    // that rebuilt `roots` purely from kept contexts would return a projection
    // with no root at all for a run that declared nothing.
    const selected = selectRequestedRows(storedExtent(), { contexts: [], rootId: ROOT_ID });

    expect(selected.roots.map((row) => row.id)).toEqual([ROOT_ID]);
  });

  it('keeps a root that a kept context names, which is the other half of the roots rule', () => {
    // The sibling root is named by no realization and no membership — only by a
    // context's own `rootId` — so this is the disjunct that reachability through
    // identities cannot reach.
    const selected = selectRequestedRows(storedExtent(), { contexts: [CTX_SIBLING], rootId: ROOT_ID });

    expect(sortedKeys(selected.roots.map((row) => row.id))).toEqual(sortedKeys([ROOT_ID, ROOT_SIBLING]));
  });

  it('narrows to exactly the eight extent-scoped tables the registry declares', () => {
    // Derived from the registry rather than listed, so a thirteenth
    // extent-scoped table makes this red instead of arriving silently unhydrated.
    const selected = selectRequestedRows(storedExtent(), { contexts: [CTX_FILESYSTEM], rootId: ROOT_ID });

    expect(sortedKeys(Object.keys(selected))).toEqual(sortedKeys(tableKeysOfScope('extent')));
  });
});

describe('blobFactsCover', () => {
  it('counts a key that a blobs row accounts for as covered', () => {
    expect(blobFactsCover(blobFacts({ blobs: [blobRow(KEY_SHARED)] }), [KEY_SHARED])).toBe(true);
  });

  it('counts a key that ONLY a blobConditions row accounts for as covered, because declining to parse is an accounting', () => {
    // 🪤 The derivation stage records a `blob_conditions` row *instead of* a
    // `blobs` row whenever it declines to parse — unreadable, changed
    // underneath, or binary (the NUL sniff). Any corpus shipping one image has
    // such keys, so a cover check reading `blobs` alone would call every real
    // corpus a miss forever and the blob tier would never be reused once.
    expect(blobFactsCover(blobFacts({ blobConditions: [blobConditionRow(KEY_BETA)] }), [KEY_BETA])).toBe(true);
  });

  it('reports the whole extent uncovered when a single key is accounted for by neither table', () => {
    // One unaccounted key means the extent was written by a run that skipped
    // blob derivation. Accepting it leaves `blob_references` empty, reduces every
    // closure extent to its own declared root, converges on iteration one, and
    // reports success — the silent-emptiness failure arriving through the cache.
    const blobs = blobFacts({ blobs: [blobRow(KEY_SHARED)], blobConditions: [blobConditionRow(KEY_BETA)] });

    expect(blobFactsCover(blobs, [KEY_SHARED, KEY_BETA, KEY_ALPHA])).toBe(false);
  });

  it('trivially covers an empty key list, so a run naming no bytes is not a miss', () => {
    expect(blobFactsCover(emptyBlobRows(), [])).toBe(true);
  });
});

describe('keyedContentKeys', () => {
  it('takes each distinct key once, in first-seen order', () => {
    // Two extents realizing one file name the same key, and the caller hands
    // this list straight to `readBlobFacts` — a duplicate is a second lookup for
    // bytes already in hand.
    const extent = extentWithRealizations([
      realization(RES_SHARED, CTX_FILESYSTEM, SHARED_PATH, keyedContent(KEY_SHARED)),
      realization(RES_ALPHA, CTX_ALPHA, ALPHA_PATH, keyedContent(KEY_ALPHA)),
      realization(RES_SHARED, CTX_ALPHA, SHARED_PATH, keyedContent(KEY_SHARED)),
    ]);

    expect(keyedContentKeys(extent)).toEqual([KEY_SHARED, KEY_ALPHA]);
  });

  it('skips a realization that has no bytes to key', () => {
    const extent = extentWithRealizations([realization(RES_ALPHA, CTX_ALPHA, 'skills/alpha', NO_CONTENT)]);

    expect(keyedContentKeys(extent)).toEqual([]);
  });

  it('reads contentState rather than a non-null key, so a fourth null state cannot slip through as bytes', () => {
    // Deliberately schema-invalid, and excluded from the fixture check below for
    // that reason: the row schema pins `keyed` to a non-null key in BOTH
    // directions, so this row cannot occur today. That is the point. The filter
    // is written against the state and not the key precisely so a fifth
    // `contentState` added later — the schema's own history records a fourth
    // being added — is excluded until someone opts it in, rather than being read
    // as a blob whose bytes were never fetched.
    const stateSaysNoBytes: ResourceRealizationRow = {
      ...realization(RES_BETA, CTX_BETA, BETA_PATH, keyedContent(KEY_BETA)),
      contentState: 'deferred',
    };

    expect(keyedContentKeys(extentWithRealizations([stateSaysNoBytes]))).toEqual([]);
  });
});

describe('assembleProjection', () => {
  it('freezes what it hands back, so a hydrated projection cannot change under a consumer', () => {
    // `ProjectionBuilder.build` freezes, and a hydrated projection has to be
    // indistinguishable from a populated one in every respect a consumer can
    // observe. Mutability is one of them.
    const projection = assembleProjection(storedExtent(), emptyBlobRows());

    expect(Object.isFrozen(projection)).toBe(true);
  });

  it('holds all twelve tables, with neither scope losing one on the way through', () => {
    const projection = assembleProjection(storedExtent(), emptyBlobRows());

    expect(sortedKeys(Object.keys(projection))).toEqual(sortedKeys(Object.keys(PROJECTION_TABLES)));
  });

  it('carries the row arrays through rather than copying them', () => {
    const extent = storedExtent();
    const blobs = blobFacts({ blobs: [blobRow(KEY_SHARED)] });

    const projection = assembleProjection(extent, blobs);

    expect(projection.resourceRealizations).toBe(extent.resourceRealizations);
    expect(projection.blobs).toBe(blobs.blobs);
  });
});

describe('emptyBlobRows', () => {
  it('has exactly the blob-scoped tables the registry declares, never a hardcoded four', () => {
    // Asserted against `PROJECTION_TABLES` rather than a literal list, because a
    // thirteenth blob-scoped table is exactly the change that must not leave a
    // blob-skipping hydration handing back eleven tables and one absent key.
    expect(sortedKeys(Object.keys(emptyBlobRows()))).toEqual(sortedKeys(tableKeysOfScope('blob')));
  });

  it('holds no rows in any of them', () => {
    for (const [name, rows] of Object.entries(emptyBlobRows())) {
      expect(rows, name).toEqual([]);
    }
  });
});

describe('the stored fixture', () => {
  it('is rows the real schemas accept, so a green suite is not a green suite over invented columns', () => {
    // Everything above argues about which rows survive a narrowing, and that
    // argument is worth nothing if the rows are shapes no contributor could
    // emit. Every column here was transcribed from the schemas by hand, and this
    // is what keeps that transcription honest as the schemas move.
    const extent = storedExtent() as unknown as Record<string, readonly unknown[]>;

    for (const spec of Object.values(PROJECTION_TABLES)) {
      if (spec.scope !== 'extent') continue;
      for (const row of extent[spec.key] ?? []) {
        const parsed = spec.schema.safeParse(row);
        expect(parsed.success ? undefined : parsed.error.message, spec.name).toBeUndefined();
      }
    }
  });
});
