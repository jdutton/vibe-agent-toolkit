import { mkdir, rm, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ParseCache } from '../src/parse-cache.js';
import {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_UNREADABLE,
  parserKindOf,
  populateBlobs,
  type BlobPopulationResult,
} from '../src/projection/blob-population.js';
import { RunContentCache } from '../src/projection/content-cache.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { ClosureExtentContributor } from '../src/projection/contributors/closure-extent.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { rootIdFor } from '../src/projection/identity.js';
import { afterClosurePromotion, populate } from '../src/projection/merge.js';
import {
  ProjectionBuilder,
  REALIZATION_PROMOTION_UNREADABLE,
  type Projection,
} from '../src/projection/projection.js';
import { collectRealization } from '../src/projection/realizations.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import {
  IN_CRAWL_ORDER,
  baseBuilderForRoot,
  type RealizationOrder,
} from './blob-fixture-population.js';
import { setupSubdirTestSuite } from './test-helpers.js';

const SKILL_KIND = 'skill';
const EXTENT_NAME = 'foo-bundle';
const NESTED_DIR = 'skills/foo';
const ROOT_DOC = 'skills/foo/SKILL.md';
const DOC_B = 'skills/foo/b.md';
const RUNNER = 'skills/foo/run.mjs';
const HELPER = 'skills/foo/helper.mjs';
const DOC_A = 'a.md';
const COPY_OF_A = 'copy-of-a.md';
const PAGE_MD = 'page.md';
const PAGE_HTML = 'page.html';

/** Bytes shared by {@link PAGE_MD} and {@link PAGE_HTML}, so only the route differs. */
const DUAL_ROUTE_CONTENT = '# Heading\n\n<a href="./b.md">b</a>\n';

/** A document with one heading and one outbound markdown link. */
const DOC_A_CONTENT = '# A\n\n[b](./b.md)\n';

/** A source file: `.ts` is typed `text/x-typescript`, which routes to no parser. */
const UNPARSED_TS = 'tools/build.ts';

/**
 * The `none`-route fixture, carrying one of every shape the two routes disagree on.
 *
 * Line 1 opens with `#`, line 5 contains a markdown inline link: under the
 * markdown route those are a heading and a `markdown-link` row, and under the
 * `none` route they are neither. Lines 2–4 carry the three lexical forms, which
 * must survive — the lexer reads RAW SOURCE and never needed an AST.
 *
 * ⚠️ The first line names the file. Blobs are content-addressed and
 * path-independent, so a fixture whose bytes are shared with the markdown twin
 * below would be ONE blob with one row set, and the whole suite would read as
 * "extension gates extraction" while proving nothing.
 */
const UNPARSED_TS_CONTENT = [
  '# build.ts — a comment in TypeScript, not an ATX heading',
  '// see ./helper.mts for the rest',
  '// bundle @packages/resources/README.md as well',
  '// and ${HOME}/.claude/settings.json',
  '// docs live at [b](./notes-b.md)',
  'export const buildTarget = 1;',
  '',
].join('\n');

/** The markdown control: the same shapes, different bytes, a parser behind them. */
const PARSED_MD = 'tools/notes.md';

/** Distinct bytes from {@link UNPARSED_TS_CONTENT} — see its warning. */
const PARSED_MD_CONTENT = '# notes.md — the markdown twin\n\ndocs live at [b](./notes-b.md)\n';

/** The directory {@link UNPARSED_TS} and {@link PARSED_MD} live in. */
const TOOLS_DIR = 'tools';

/** A syntactically valid digest — these tests are about the PREFIX, not the hash. */
const ANY_DIGEST = 'a'.repeat(64);

/** `syntacticForm` of a reference the markdown AST produced. Only a parser can emit one. */
const MARKDOWN_LINK = 'markdown-link';

/** `syntacticForm` of a path-shaped token the raw-source lexer found. No AST needed. */
const BARE_TOKEN = 'bare-token';

/**
 * A cache that never touches disk.
 *
 * The unit tests below assert what this stage derives, not what a previous run
 * left in a shared temp directory — and a content-addressed cache is invisible
 * by construction, so a test served from one proves nothing about the code path
 * it meant to exercise.
 */
const NO_CACHE = new ParseCache({ enabled: false });

/** One fixture file. */
interface CorpusFile {
  path: string;
  content: string;
}

/**
 * The exact opposite of enumeration order.
 *
 * `crawlDirectory`'s directory route returns filesystem order, which differs
 * across ext4, APFS and NTFS. Reversing is the cheapest fixture that can tell a
 * sorted stage from one that merely happens to agree with the crawl.
 */
const REVERSED: RealizationOrder = (rows) => [...rows].reverse();

/** UTF-16 code-unit order — never `localeCompare`, which is locale-dependent. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const suite = setupSubdirTestSuite('blob-population-');

async function writeCorpus(files: readonly CorpusFile[], directories: readonly string[] = []): Promise<void> {
  for (const directory of directories) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture directory beneath a mkdtemp root
    await mkdir(safePath.join(suite.tempDir, directory), { recursive: true });
  }
  await Promise.all(files.map((file) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
    writeFile(safePath.join(suite.tempDir, file.path), file.content, 'utf-8')));
}

/** Overwrite or delete one fixture file after its realization row already exists. */
async function rewriteCorpusFile(relativePath: string, content: string | null): Promise<void> {
  const absolute = safePath.join(suite.tempDir, relativePath);
  if (content === null) {
    await rm(absolute, { force: true });
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(absolute, content, 'utf-8');
}

/**
 * The shared base-stratum builder, bound to this suite's per-test root.
 *
 * The construction itself lives in `blob-fixture-population.ts` because a second
 * suite drives `populateBlobs` the same way; two copies of a base-stratum driver
 * drift, and one suite then quietly stops testing the pipeline the other does.
 *
 * @param order - How to reorder the realizations before recording them
 * @param contentCache - The run cache to share, for the tests that pin the
 *   *cached* semantics; omitted elsewhere so the derivation-time read is a
 *   genuine second read
 * @returns A builder carrying the base stratum and nothing else
 */
async function baseBuilderFor(
  order?: RealizationOrder,
  contentCache?: RunContentCache,
): Promise<ProjectionBuilder> {
  return baseBuilderForRoot(suite.tempDir, order, contentCache);
}

/** The extent the demand fixtures below realize their files in. */
const DEFERRING_EXTENT = 'ctx-deferring';

/**
 * A base builder in which exactly one path was realized under
 * `contentDemand: 'deferred'` and the rest eagerly.
 *
 * `FilesystemExtentContributor` defers only *gitignored* paths, which needs a
 * real repository and a real `.gitignore` to reproduce; the policy itself is
 * what these tests are about, so they set it directly on `collectRealization`.
 *
 * The fixture's two files are deliberately asymmetric: {@link DOC_A} carries an
 * outbound link and {@link PAGE_MD} carries none, so "the deferred blob was
 * derived" and "it was not" produce visibly different `blob_references` tables.
 * A deferred file with no links would leave both outcomes identical.
 */
async function builderWithDeferredPath(
  deferredPath: string,
  files: readonly CorpusFile[],
  cache: RunContentCache,
): Promise<ProjectionBuilder> {
  const builder = new ProjectionBuilder({ root: suite.tempDir, contentCache: cache });
  for (const file of files) {
    const absolute = safePath.join(suite.tempDir, file.path);
    const resourceId = builder.identities.idFor(absolute);
    builder.addResource({
      resourceId,
      kind: 'file',
      origin: 'filesystem',
      observed: true,
      fromEnumeration: true,
      vatId: null,
    });
    // Sequential: each row's read shares one cache, which is the point.
    const row = await collectRealization(absolute, resourceId, {
      root: suite.tempDir,
      extentId: DEFERRING_EXTENT,
      contentCache: cache,
      contentDemand: file.path === deferredPath ? 'deferred' : 'eager',
    });
    builder.addRealization(row);
  }
  return builder;
}

/** The two-file corpus the demand fixtures use: one linking file, one leaf. */
const DEMAND_CORPUS: readonly CorpusFile[] = [
  { path: DOC_A, content: DOC_A_CONTENT },
  { path: PAGE_MD, content: '# Leaf\n\nNothing links out of here.\n' },
];

/** The four blob-keyed tables, serialized for byte-identity comparison. */
function blobTablesOf(projection: Projection): string {
  return JSON.stringify([
    projection.blobs,
    projection.blobReferences,
    projection.blobSections,
    projection.blobConditions,
  ]);
}

/**
 * Where a token sits in the source, as `[startOffset, endOffset)`.
 *
 * Derived from the fixture rather than written out, so an edit to the fixture
 * cannot leave a hand-counted offset silently pointing at the wrong characters.
 *
 * @param content - The fixture source
 * @param token - The exact token to locate
 * @returns Its half-open offset range
 */
function offsetsOf(content: string, token: string): [number, number] {
  const start = content.indexOf(token);
  return [start, start + token.length];
}

/** What one derivation of the two-route fixture pair yields. */
interface TwoRouteDerivation {
  projection: Projection;
  counts: BlobPopulationResult;
  /** Key of the `.ts` blob — `none.<digest>`, no parser behind it. */
  unparsedKey: string;
  /** Key of the `.md` twin — `markdown.<digest>`, the differential control. */
  parsedKey: string;
}

/**
 * Derive {@link UNPARSED_TS} and {@link PARSED_MD} in one run and name both keys.
 *
 * One helper rather than a per-test preamble because every assertion in the
 * `none`-route suite is a comparison between the two routes, and two copies of
 * the setup are two chances for the pair to stop being the same run.
 *
 * @returns The projection, the stage's counters, and a key per route
 */
async function deriveBothRoutes(): Promise<TwoRouteDerivation> {
  const builder = await baseBuilderFor();
  const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
  const projection = builder.build();
  const keyFor = (path: string): string =>
    projection.resourceRealizations.find((row) => row.path === path)?.contentKey ?? '';
  return { projection, counts, unparsedKey: keyFor(UNPARSED_TS), parsedKey: keyFor(PARSED_MD) };
}

const SKILL_CORPUS: readonly CorpusFile[] = [
  { path: ROOT_DOC, content: '---\nname: foo\n---\n\n# Foo\n\nSee [b](./b.md) and the [runner](./run.mjs).\n' },
  { path: DOC_B, content: '# B\n\nNothing links out of here.\n' },
  // The edge that only the raw-source lexer can see: a bare relative token in a
  // file the markdown AST would never produce a link row for.
  { path: RUNNER, content: '// entry point\n// see ./helper.mjs for the rest\nexport const x = 1;\n' },
  { path: HELPER, content: 'export const y = 2;\n' },
  { path: 'README.md', content: '# Unrelated\n\nNot reachable from the skill.\n' },
];

function closureDeclaration(): Record<string, JsonValue> {
  return {
    kind: SKILL_KIND,
    closureFrom: ROOT_DOC,
    follow: [MARKDOWN_LINK, BARE_TOKEN],
    maxDepth: 'full',
  };
}

function registryWithClosure(): ContributorRegistry {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  registry.register(new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND));
  return registry;
}

/** Run the whole driver over the skill corpus, capturing the stage's counters. */
async function populateSkillCorpus(): Promise<{ projection: Projection; counts: BlobPopulationResult }> {
  let counts: BlobPopulationResult | undefined;
  const projection = await populate({
    root: suite.tempDir,
    registry: registryWithClosure(),
    parameters: { [`closure:${EXTENT_NAME}`]: closureDeclaration() },
    onBlobPopulation: (result) => {
      counts = result;
    },
  });
  expect(counts).toBeDefined();
  return { projection, counts: counts ?? unreachableCounts() };
}

/** Only reachable if the assertion above stopped asserting. */
function unreachableCounts(): BlobPopulationResult {
  throw new Error('populate() did not report blob-population counts');
}

/** Paths realized in one extent, in code-unit order. */
function memberPaths(projection: Projection, extentId: string): string[] {
  return projection.resourceRealizations
    .filter((row) => row.extentId === extentId)
    .map((row) => row.path)
    .sort(byCodeUnit);
}

describe('populateBlobs, through populate()', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await writeCorpus(SKILL_CORPUS, [NESTED_DIR]);
  });

  it('gives a closure extent more than its declared root', async () => {
    // The whole reason this stage exists. Without it `blob_references` is empty,
    // `ClosureExtentContributor` finds no edges, the fixpoint converges on
    // iteration one, and `populate()` reports success over an extent containing
    // only its own SKILL.md.
    const { projection } = await populateSkillCorpus();
    const extentId = extentContextId(SKILL_KIND, rootIdFor(suite.tempDir), EXTENT_NAME);

    expect(memberPaths(projection, extentId)).toEqual([DOC_B, HELPER, RUNNER, ROOT_DOC].sort(byCodeUnit));
  });

  it('lets a non-markdown blob supply an edge, via the raw-source lexer', async () => {
    // `helper.mjs` is reachable ONLY through a bare token inside `run.mjs`, a
    // file the markdown AST produces no link row for. An extension allowlist on
    // this stage would make a skill's bundled scripts permanently unreachable.
    const { projection } = await populateSkillCorpus();
    const runnerKey = projection.resourceRealizations.find((row) => row.path === RUNNER)?.contentKey;

    const lexed = projection.blobReferences.filter((row) => row.blob === runnerKey);
    expect(lexed).toHaveLength(1);
    expect(lexed[0]?.rawRef).toBe('./helper.mjs');
    expect(lexed[0]?.syntacticForm).toBe(BARE_TOKEN);
  });

  it('skips no heading and no reference for want of a source line', async () => {
    // `HeadingNode.line` and `ResourceLink.line` are optional while the row
    // columns they feed are required and positive, and both are handled by
    // skipping rather than defaulting to line 1. These two counters are the only
    // way that skip is observable — a skipped row is, definitionally, absent.
    const { counts } = await populateSkillCorpus();

    expect(counts.headingsSkippedForMissingLine).toBe(0);
    expect(counts.referencesSkippedForMissingLine).toBe(0);
  });

  it('derives one blob per file and attributes every directory it skipped', async () => {
    const { projection, counts } = await populateSkillCorpus();

    expect(counts.blobsDerived).toBe(SKILL_CORPUS.length);
    expect(projection.blobs).toHaveLength(SKILL_CORPUS.length);
    // `skills` and `skills/foo` — a directory has no blob, and saying so by
    // bucket is what keeps "derived nothing" distinguishable from "found nothing".
    expect(counts.realizationsSkippedDirectory).toBe(2);
    expect(counts.realizationsSkippedAbsent).toBe(0);
    expect(counts.realizationsSkippedUnkeyed).toBe(0);
    expect(counts.blobsUnreadable).toBe(0);
  });

  it('fills every blob-keyed table, not only the one the closure reads', async () => {
    const { projection } = await populateSkillCorpus();

    expect(projection.blobSections.length).toBeGreaterThan(0);
    expect(projection.blobReferences.length).toBeGreaterThan(0);
    expect(projection.blobs.every((row) => row.tokenEstimate > 0)).toBe(true);
  });
});

describe('populateBlobs', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('derives once per distinct content key, not once per realization', async () => {
    await writeCorpus([
      { path: DOC_A, content: DOC_A_CONTENT },
      { path: COPY_OF_A, content: DOC_A_CONTENT },
    ]);
    const builder = await baseBuilderFor();

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });

    // Two realizations, two paths, ONE blob — the point of a content-addressed
    // blob layer, and the difference between one parse and two.
    expect(builder.build().resourceRealizations).toHaveLength(2);
    expect(counts.blobsDerived).toBe(1);
    expect(builder.build().blobs).toHaveLength(1);
  });

  it('routes a blob by its key prefix, so identical bytes at .md and .html differ', async () => {
    await writeCorpus([
      { path: PAGE_MD, content: DUAL_ROUTE_CONTENT },
      { path: PAGE_HTML, content: DUAL_ROUTE_CONTENT },
    ]);
    const builder = await baseBuilderFor();

    await populateBlobs(builder, { parseCache: NO_CACHE });
    const { blobs } = builder.build();

    // Same bytes, two keys, two rows: the parser kind is in the hash preimage.
    // The markdown route sees an ATX heading; the HTML route sees none. A fixture
    // whose two answers were equal would not be able to tell the routes apart.
    expect(blobs).toHaveLength(2);
    expect(blobs.find((row) => row.contentKey.startsWith('markdown.'))?.headingCount).toBe(1);
    expect(blobs.find((row) => row.contentKey.startsWith('html.'))?.headingCount).toBe(0);
  });

  it('records an unreadable blob as a condition and keeps going', async () => {
    await writeCorpus([
      { path: DOC_A, content: '# A\n' },
      { path: DOC_B, content: '# B\n' },
    ], [NESTED_DIR]);
    const builder = await baseBuilderFor();
    // Readable when the base enumerated it, gone by the time it is derived.
    await rewriteCorpusFile(DOC_A, null);

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    expect(counts.blobsUnreadable).toBe(1);
    // The other blob still landed: one permissions quirk must not destroy a run.
    expect(counts.blobsDerived).toBe(1);
    const conditions = projection.blobConditions.filter((row) => row.code === BLOB_UNREADABLE);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.message).toContain(DOC_A);
    // Evidence, never `$HOME`: every other path column in the projection is
    // root-relative, and an fs error's own message embeds the absolute path.
    expect(conditions[0]?.message).not.toContain(suite.tempDir);
  });

  it('declines a binary blob before parsing it, and says so in a condition', async () => {
    await writeCorpus([
      { path: DOC_A, content: DOC_A_CONTENT },
      // A NUL inside the sniff window is the whole signal — the extension is
      // `.md`, so an extension-based rule would parse this and a renamed
      // archive would still be handed to `remark-parse`.
      { path: 'archive.md', content: 'PK\u0003\u0004\u0000\u0000binary payload' },
    ]);
    const builder = await baseBuilderFor();

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    expect(counts.blobsNotText).toBe(1);
    // The text blob is unaffected: the refusal is per blob, not a mode.
    expect(counts.blobsDerived).toBe(1);
    // A refusal, not a silence — no blob row, but a row saying why there is none.
    expect(projection.blobs).toHaveLength(1);
    const conditions = projection.blobConditions.filter((row) => row.code === BLOB_NOT_TEXT);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.message).toContain('archive.md');
    expect(conditions[0]?.message).not.toContain(suite.tempDir);
  });

  it('derives a text file with no extension, so the refusal is about bytes and not names', async () => {
    // The negative control for the test above, and it is what keeps the sniff
    // from being quietly replaced by an extension allowlist: a bundled script
    // is exactly the reference source the closure exists to read, and it has no
    // extension in common with markdown.
    //
    // `Makefile` is not in `mime-type.ts`'s well-known basenames, so it routes to
    // `none` and no parser reads it — and the reference below is still found,
    // because the LEXER is what finds it and the lexer never needed an AST. The
    // token is deliberately bare rather than `[docs](./a.md)`: a markdown link in
    // an unparsed blob is lexed as one whitespace-delimited run, so it would
    // arrive as `docs](./a.md` and prove something about tokenization instead.
    await writeCorpus([{ path: 'Makefile', content: '# Build\n\nsee ./a.md for the target\n' }]);
    const builder = await baseBuilderFor();

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });

    expect(counts.blobsNotText).toBe(0);
    expect(counts.blobsDerived).toBe(1);
    expect(builder.build().blobReferences.map((row) => row.rawRef)).toContain('./a.md');
  });

  it('refuses to derive a blob from bytes that no longer key to it', async () => {
    await writeCorpus([{ path: DOC_A, content: '# A\n' }]);
    const builder = await baseBuilderFor();
    await rewriteCorpusFile(DOC_A, '# A, rewritten between enumeration and derivation\n');

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    // Filing these facts under the recorded key would be a well-formed row with
    // the wrong contents — the failure fail-soft handling explicitly misses.
    expect(counts.blobsContentChanged).toBe(1);
    expect(counts.blobsDerived).toBe(0);
    expect(projection.blobs).toHaveLength(0);
    expect(projection.blobConditions.map((row) => row.code)).toEqual([BLOB_CONTENT_CHANGED]);
  });

  // The two tests below pin the semantics the per-run content cache chose, and
  // they are the deliberate counterpart to the two above: with a cache, a
  // population describes ONE consistent instant — the instant each path was
  // first read — rather than a smear across whichever stage read first. Both
  // conditions above therefore become unreachable for a path the run already
  // read, which is every path `populate()` derives a blob from. Without this
  // pair, that behaviour change could be reverted or re-broken silently.
  it('derives from the bytes the base read when a run cache holds them, not from a mid-run rewrite', async () => {
    await writeCorpus([{ path: DOC_A, content: '# A\n' }]);
    const builder = await baseBuilderFor(IN_CRAWL_ORDER, new RunContentCache());
    const enumerated = builder.build().resourceRealizations
      .find((row) => row.path === DOC_A)?.contentKey;
    await rewriteCorpusFile(DOC_A, '# A, rewritten between enumeration and derivation\n');

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    expect(counts.blobsContentChanged).toBe(0);
    expect(counts.blobsDerived).toBe(1);
    expect(projection.blobConditions).toHaveLength(0);
    // The blob describes the enumerated bytes, and the realization row that
    // names it is still true of them — which is the whole property.
    expect(projection.blobs.map((row) => row.contentKey)).toEqual([enumerated]);
  });

  it('derives from the bytes the base read when a run cache holds them, even after the file is deleted', async () => {
    await writeCorpus([{ path: DOC_A, content: '# A\n' }]);
    const builder = await baseBuilderFor(IN_CRAWL_ORDER, new RunContentCache());
    await rewriteCorpusFile(DOC_A, null);

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });

    // Same instant, same answer: `BLOB_UNREADABLE` is about a read this run has
    // to make, and with the bytes already held there is no such read.
    expect(counts.blobsUnreadable).toBe(0);
    expect(counts.blobsDerived).toBe(1);
  });

  it('produces byte-identical tables whatever order the crawl enumerated in', async () => {
    await writeCorpus([
      { path: DOC_A, content: DOC_A_CONTENT },
      { path: DOC_B, content: '# B\n\n## Deeper\n' },
      { path: ROOT_DOC, content: '# Skill\n\n[a](../../a.md)\n' },
    ], [NESTED_DIR]);

    const forward = await baseBuilderFor(IN_CRAWL_ORDER);
    await populateBlobs(forward, { parseCache: NO_CACHE });
    const backward = await baseBuilderFor(REVERSED);
    await populateBlobs(backward, { parseCache: NO_CACHE });

    // The two builders hold the same rows in opposite insertion order, so only a
    // stage that sorts by content key can make these strings equal.
    expect(blobTablesOf(backward.build())).toBe(blobTablesOf(forward.build()));
    const emitted = forward.build().blobs.map((row) => row.contentKey);
    const sorted = forward.build().blobs.map((row) => row.contentKey).sort(byCodeUnit);
    expect(emitted).toEqual(sorted);
  });

  it('counts a positionless reference as skipped rather than defaulting it to line 1', async () => {
    // Measured, not hypothetical: remark hands `toResourceLink` a `link` node
    // with no `position` when a GFM autolink literal is wrapped in quotes and
    // parentheses, and this exact shape accounts for all 77 skipped references
    // over this repository's corpus. If the parser is ever fixed upstream this
    // test goes red, which is the correct signal — not a reason to default.
    await writeCorpus([{ path: DOC_A, content: '"WebFetch(domain:www.anthropic.com)"\n' }]);
    const builder = await baseBuilderFor();

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    expect(counts.referencesSkippedForMissingLine).toBe(1);
    expect(projection.blobReferences).toHaveLength(0);
    expect(projection.blobs[0]?.linkCount).toBe(1);
  });

  it('changes nothing when run a second time against the same builder', async () => {
    await writeCorpus([
      { path: DOC_A, content: DOC_A_CONTENT },
      { path: DOC_B, content: '# B\n' },
    ], [NESTED_DIR]);
    const builder = await baseBuilderFor();

    const first = await populateBlobs(builder, { parseCache: NO_CACHE });
    const before = blobTablesOf(builder.build());
    const second = await populateBlobs(builder, { parseCache: NO_CACHE });

    // The closure stratum re-runs to a fixpoint; blob rows that churned would
    // keep the digests moving and turn convergence into an unconditional error.
    expect(blobTablesOf(builder.build())).toBe(before);
    expect(first.blobsDerived).toBe(2);
    expect(second.blobsDerived).toBe(0);
    expect(second.blobsAlreadyPresent).toBe(2);
  });
});

describe('populateBlobs, over deferred realizations', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await writeCorpus(DEMAND_CORPUS);
  });

  it('derives no blob for a deferred realization and counts it apart from every skip', async () => {
    const cache = new RunContentCache();
    const builder = await builderWithDeferredPath(DOC_A, DEMAND_CORPUS, cache);

    const counts = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    expect(counts.realizationsContentDeferred).toBe(1);
    // The distinction the counter exists for: a deliberate non-read is not a
    // read that failed, and folding it into the residue bucket would make the
    // demand design indistinguishable from a corpus full of permissions errors.
    expect(counts.realizationsSkippedUnkeyed).toBe(0);
    expect(counts.realizationsSkippedAbsent).toBe(0);
    // Only the eagerly keyed leaf got a blob, and the leaf has no links — so an
    // empty reference table really does mean the deferred blob was not derived.
    expect(counts.blobsDerived).toBe(1);
    expect(projection.blobs).toHaveLength(1);
    expect(projection.blobReferences).toHaveLength(0);
  });

  it('derives the promoted blob, and its references, on a second run', async () => {
    const cache = new RunContentCache();
    const builder = await builderWithDeferredPath(DOC_A, DEMAND_CORPUS, cache);
    await populateBlobs(builder, { parseCache: NO_CACHE });

    const key = await builder.ensureContentKey(DOC_A);
    const second = await populateBlobs(builder, { parseCache: NO_CACHE });
    const projection = builder.build();

    expect(second.realizationsContentDeferred).toBe(0);
    expect(second.blobsDerived).toBe(1);
    expect(second.blobsAlreadyPresent).toBe(1);
    expect(projection.blobs.map((row) => row.contentKey)).toContain(key);
    // The edge the deferred blob was hiding. Without the second run the
    // realization would name a blob with no rows — a dangling foreign key.
    expect(projection.blobReferences.map((row) => row.rawRef)).toEqual(['./b.md']);
  });
});

describe('afterClosurePromotion', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await writeCorpus(DEMAND_CORPUS);
  });

  it('reports nothing at all when the closure stratum promoted no realization', async () => {
    const cache = new RunContentCache();
    const builder = await builderWithDeferredPath(DOC_A, DEMAND_CORPUS, cache);
    await populateBlobs(builder, { parseCache: NO_CACHE });

    const report = await afterClosurePromotion(builder, builder.contentPromotionAttempts);

    // An ABSENT key, not a zeroed result: "the stage did not need to run again"
    // and "it ran again and derived nothing" are different facts.
    expect(report).toEqual({});
    expect('afterClosurePromotion' in report).toBe(false);
  });

  it('reports the post-fixpoint run as its own result rather than merging counters', async () => {
    const cache = new RunContentCache();
    const builder = await builderWithDeferredPath(DOC_A, DEMAND_CORPUS, cache);
    const first = await populateBlobs(builder, { parseCache: NO_CACHE });
    const before = builder.contentPromotionAttempts;
    await builder.ensureContentKey(DOC_A);

    const report = await afterClosurePromotion(builder, before);

    expect(report.afterClosurePromotion?.blobsDerived).toBe(1);
    // The reason there is no honest sum: the second pass counts as "already
    // present" nearly every blob the first pass derived, so adding the two
    // reports a corpus larger than the corpus.
    expect(first.blobsAlreadyPresent).toBe(0);
    expect(report.afterClosurePromotion?.blobsAlreadyPresent).toBe(1);
    expect(builder.build().blobs).toHaveLength(2);
  });

  it('reports a promotion whose every read FAILED, rather than the deliberate no-op', async () => {
    // The defect: the gate read `contentPromotions`, the SUCCESS counter, which
    // `ensureContentKey` leaves untouched when the read throws. So a closure
    // stratum that demanded bytes and could not read one of them returned the
    // identical `{}` as a stratum where nobody asked at all — one corpus of
    // unreadable files and one deliberate no-op, emitting one signal.
    const cache = new RunContentCache();
    const builder = await builderWithDeferredPath(DOC_A, DEMAND_CORPUS, cache);
    await populateBlobs(builder, { parseCache: NO_CACHE });
    const before = builder.contentPromotionAttempts;

    // The read is deferred, so deleting now makes the demand-time read the
    // first and only one — and it fails.
    await rm(safePath.join(suite.tempDir, DOC_A), { force: true });
    expect(await builder.ensureContentKey(DOC_A)).toBeNull();
    // The premise, asserted: this really is the "asked and failed" shape, not
    // "asked and succeeded" and not "never asked".
    expect(builder.contentPromotionAttempts).toBe(before + 1);
    expect(builder.contentPromotions).toBe(0);

    const report = await afterClosurePromotion(builder, before);

    // PRESENT — the whole point. A `{}` here would be the no-op's answer.
    expect('afterClosurePromotion' in report).toBe(true);
    // And honest about what it found: nothing new was derivable, because no key
    // entered the projection.
    expect(report.afterClosurePromotion?.blobsDerived).toBe(0);
    // The row that carries the cause. `blobsUnreadable` cannot: there is no blob
    // and therefore no content key to hang a `blob_conditions` row on.
    expect(builder.build().realizationConditions.map((row) => row.code))
      .toEqual([REALIZATION_PROMOTION_UNREADABLE]);
  });
});

describe('populateBlobs, over blobs no document parser routes to', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await writeCorpus([
      { path: UNPARSED_TS, content: UNPARSED_TS_CONTENT },
      { path: PARSED_MD, content: PARSED_MD_CONTENT },
    ], [TOOLS_DIR]);
  });

  it('gives it a blobs row with a real token estimate, rather than refusing it', async () => {
    // The whole reason `none` is a third shape and not a fourth refusal. With no
    // `blobs` row there is no `tokenEstimate`, `whatLoadsAt` reports
    // `tokens: null`, and `chargeOf` answers `unknown-size` — a live accounting
    // state that would appear the moment a CLAUDE.md imports a `.ts` file.
    const { projection, unparsedKey } = await deriveBothRoutes();
    const row = projection.blobs.find((blob) => blob.contentKey === unparsedKey);

    expect(unparsedKey.startsWith('none.')).toBe(true);
    expect(row).toBeDefined();
    expect(row?.tokenEstimate).toBeGreaterThan(0);
    // `measureContent` runs too, so the row is measured rather than merely present.
    expect(row?.wordCount).toBeGreaterThan(0);
    // Every code unit is prose, because no AST said where any fence is.
    expect(row?.proseCodeUnits).toBe(UNPARSED_TS_CONTENT.length);
    expect(row?.codeBlockCodeUnits).toBe(0);
    // `bytes` is the RAW on-disk count and stays apart from the code-unit count:
    // the fixture's two em-dashes are one code unit and three bytes each.
    expect(row?.bytes).toBe(Buffer.byteLength(UNPARSED_TS_CONTENT, 'utf-8'));
    expect(row?.bytes).toBeGreaterThan(UNPARSED_TS_CONTENT.length);
  });

  it('runs no document parser over it: no headings, no sections, no markdown links', async () => {
    const { projection, unparsedKey } = await deriveBothRoutes();
    const row = projection.blobs.find((blob) => blob.contentKey === unparsedKey);

    // Line 1 of the fixture opens with `#` and line 5 holds `[b](./notes-b.md)`.
    // A route that handed these bytes to remark would report 1 and 1.
    expect(row?.headingCount).toBe(0);
    expect(row?.sectionCount).toBe(0);
    expect(row?.linkCount).toBe(0);
    expect(projection.blobSections.filter((section) => section.blob === unparsedKey)).toEqual([]);
    expect(projection.blobReferences
      .filter((reference) => reference.blob === unparsedKey)
      .map((reference) => reference.syntacticForm))
      .not.toContain(MARKDOWN_LINK);
  });

  it('still runs the raw-source lexer, at the offsets the source has', async () => {
    // 🔑 The constraint that decides correctness: route away from the PARSER,
    // never from the LEXER. `findLexicalReferences` reads raw source and needs no
    // AST, and it is what makes a skill's bundled scripts closure members at all —
    // the exact `files:`-blindness family the projection exists to make queryable.
    const { projection, unparsedKey } = await deriveBothRoutes();
    const lexed = projection.blobReferences.filter((row) => row.blob === unparsedKey);

    expect(lexed.map((row) => [row.syntacticForm, row.rawRef, row.line])).toEqual([
      [BARE_TOKEN, './helper.mts', 2],
      ['at-prefixed', '@packages/resources/README.md', 3],
      ['env-anchored', '${HOME}/.claude/settings.json', 4],
      // Line 5's `[b](./notes-b.md)`, and it is recorded rather than hidden: with
      // no AST a markdown link is one whitespace-delimited run, so the lexer
      // strips the leading `[` and the trailing `)` and stops at `d`. That is
      // what a markdown link IS to a reader that has no parser — and it is
      // emphatically not the `markdown-link` row the twin below gets.
      [BARE_TOKEN, 'b](./notes-b.md', 5],
    ]);

    // Offsets index the SOURCE, so a rewriter can replace exactly the token.
    const offsets = lexed.map((row) => [row.startOffset, row.endOffset]);
    expect(offsets.slice(0, 3)).toEqual([
      offsetsOf(UNPARSED_TS_CONTENT, './helper.mts'),
      offsetsOf(UNPARSED_TS_CONTENT, '@packages/resources/README.md'),
      offsetsOf(UNPARSED_TS_CONTENT, '${HOME}/.claude/settings.json'),
    ]);
    expect(lexed.map((row) => UNPARSED_TS_CONTENT.slice(row.startOffset, row.endOffset)))
      .toEqual(lexed.map((row) => row.rawRef));

    // Every lexical row reports `inFence: false` / `inCodeSpan: false`, because a
    // blob with no AST has no fences to be inside. Honest rather than lossy — see
    // `NO_CODE_CONTEXT` in blob-population.ts for the measurement.
    expect(lexed.every((row) => !row.inFence && !row.inCodeSpan)).toBe(true);
  });

  it('parses the markdown twin, so the difference is the route and not the bytes', async () => {
    // The differential control. Without it every assertion above is equally
    // satisfied by a stage that derives nothing useful for anybody.
    const { projection, parsedKey, unparsedKey } = await deriveBothRoutes();
    const row = projection.blobs.find((blob) => blob.contentKey === parsedKey);

    expect(parsedKey).not.toBe(unparsedKey);
    expect(parsedKey.startsWith('markdown.')).toBe(true);
    expect(row?.headingCount).toBe(1);
    expect(row?.linkCount).toBe(1);
    expect(projection.blobSections.filter((section) => section.blob === parsedKey))
      .toHaveLength(1);
    expect(projection.blobReferences
      .filter((reference) => reference.blob === parsedKey)
      .map((reference) => reference.syntacticForm))
      .toEqual([MARKDOWN_LINK]);
  });

  it('counts it as derived and as unparsed, and records no condition against it', async () => {
    const { projection, counts } = await deriveBothRoutes();

    // Derived, not declined: `blobsWithoutParser` is a SUBSET of `blobsDerived`.
    expect(counts.blobsDerived).toBe(2);
    expect(counts.blobsWithoutParser).toBe(1);
    // None of the refusal buckets, because nothing was refused.
    expect(counts.blobsNotText).toBe(0);
    expect(counts.blobsParseFailed).toBe(0);
    expect(counts.blobsUnreadable).toBe(0);
    // ⛔ And NO per-blob condition row. The `none.` key prefix already records,
    // exactly and per blob, that no parser ran; a row per unparsed blob would be
    // a five-column restatement of the primary key on most files in a repository.
    expect(projection.blobConditions).toEqual([]);
  });
});

describe('parserKindOf', () => {
  it('reads all three kinds off a key, with no else-branch to fall into', () => {
    // The defect this pins is invisible to `tsc`: `startsWith('html.') ? 'html' :
    // 'markdown'` compiles perfectly and silently relabels every `none.` key as
    // markdown, routing a blob with no parser straight back into the parse path.
    expect(parserKindOf(`none.${ANY_DIGEST}`)).toBe('none');
    expect(parserKindOf(`markdown.${ANY_DIGEST}`)).toBe('markdown');
    expect(parserKindOf(`html.${ANY_DIGEST}`)).toBe('html');
  });

  it('throws on a key naming no kind, rather than guessing one', () => {
    // Unreachable through the schema, which is exactly why the alternative is
    // worse: a default would make an impossible key derive real-looking facts.
    expect(() => parserKindOf(`brainfuck.${ANY_DIGEST}`)).toThrow(/brainfuck/u);
    expect(() => parserKindOf(ANY_DIGEST)).toThrow();
  });
});
