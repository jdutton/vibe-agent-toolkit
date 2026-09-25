/**
 * Fixture machinery for the projection query suites — shared by
 * `projection-closure-extent.test.ts`, `projection-closure-provenance.test.ts`
 * and `projection-claude-context-query.test.ts`.
 *
 * ## `addFile` lives here, and only here
 *
 * A synthetic `{ rawRef, syntacticForm }` pair
 * is a row the shipped lexer can never emit — `{ rawRef: 'b.md', syntacticForm:
 * 'at-prefixed' }` shipped once and left the `@`-following path green while
 * never once resolving a real `@` token. `addFile`'s `markdown` branch is the
 * fix: it runs a fixture file's content through the REAL producer chain
 * (`parseMarkdownContent` → `blobReferencesFor` → `blobRowFor`), so every
 * column a fixture exercises — `syntacticForm`, `leadingAt`, `hasExtension`,
 * `slashCount`, `inFence`, `inCodeSpan`, and now `tokenEstimate` and
 * `frontmatter` — is whatever the shipped lexer and parser really compute.
 * Duplicating this apparatus per suite is exactly the risk it exists to
 * remove, so it is written ONCE and both suites import it.
 *
 * ## `claudeContextFixture` builds a FULL `Projection`, not just two tables
 *
 * `closureFixtureFrom` (below) returns only
 * `{ resourceRealizations, blobReferences }`, because that is all
 * `closureProvenance` reads. `whatLoadsAt` reads the whole projection —
 * `resourceTags` (ancestry, rule-scope), `blobs` (tokens), `resourceExtents`
 * and `zoneProvenance` (import-closure membership and provenance) — so this
 * helper runs the SHIPPED contributors (`AgenticConventionContributor`,
 * `ClaudeRulesScopeContributor`, `ClaudeImportExtentContributor`) over the
 * assembled base, rather than hand-writing tags or memberships. That is the
 * same reason `addFile` reuses the real parser: a hand-rolled tag list or
 * membership set is a second implementation of a rule this module already
 * owns, and the two are free to drift the moment either one changes.
 *
 * ## The corpus root does not exist on disk — deliberately
 *
 * `closureProvenance` is a pure function of the tables it is handed, never of
 * the filesystem, and `CLAUDE_CONTEXT_FIXTURE_ROOT` is what makes that a testable claim rather
 * than an assertion: if a resolution path ever started `stat`-ing, a fixture
 * rooted at a real directory would never catch it. `whatLoadsAt` inherits the
 * same claim — it reads only materialised tables — so it gets the same root.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';

import { computeContentKey } from '../../src/content-key.js';
import { parseMarkdownContent } from '../../src/link-parser.js';
import { mimeTypeForPath } from '../../src/mime-type.js';
import { blobRowFor, harnessRowsFor } from '../../src/projection/blob-facts.js';
import { blobReferencesFor } from '../../src/projection/blob-references.js';
import type { ExtentContribution } from '../../src/projection/contributor.js';
import { AgenticConventionContributor } from '../../src/projection/contributors/agentic-convention.js';
import {
  ClaudeImportExtentContributor,
  claudeImportContributorId,
  claudeImportExtentDeclaration,
  claudeImportRootsFrom,
  CLAUDE_IMPORT_KIND,
} from '../../src/projection/contributors/claude-import-extent.js';
import { ClaudeRulesScopeContributor } from '../../src/projection/contributors/claude-rules-scope.js';
import { extentContextId } from '../../src/projection/contributors/context-id.js';
import { extentDigest } from '../../src/projection/digest.js';
import { CLAUDE_CODE } from '../../src/projection/harness/claude-code.js';
import {
  assertHarnessSettled,
  runHarnessPass,
  type HarnessContentReader,
} from '../../src/projection/harness/harness-pass.js';
import { ProjectionBuilder, type Projection, type ProjectionBase } from '../../src/projection/projection.js';
import type { BlobReferenceRow, ReferenceSyntacticForm } from '../../src/schemas/projection-blobs.js';
import type { ResourceRealizationRow } from '../../src/schemas/projection-resources.js';
import type { JsonValue } from '../../src/schemas/projection-shared.js';

/** One reference candidate to plant in a fixture blob (the hand-built path). */
export interface FixtureRef {
  rawRef: string;
  syntacticForm?: ReferenceSyntacticForm;
  inFence?: boolean;
}

/**
 * One fixture file: a path in the base extent plus its content.
 *
 * `markdown` runs through the REAL parse pipeline (`parseMarkdownContent` →
 * `blobReferencesFor`/`blobRowFor`); `refs` hand-plants `blob_references` rows
 * directly, which is the right tool ONLY for a column combination (a
 * `gitignored` target, say) no source text would produce — see
 * `FixtureFile.markdown`'s own history in `projection-closure-extent.test.ts`.
 */
export interface FixtureFile {
  path: string;
  refs: readonly FixtureRef[];
  markdown?: string;
  /** The `resources.kind` this entity gets. Defaults to `file`. */
  kind?: string;
  /**
   * Boolean realization columns overriding the defaults, for `flags` rules.
   *
   * A `Partial` of the row rather than named booleans, so a column added to
   * `ResourceRealizationRow` becomes fixture-settable without touching this
   * type.
   */
  columns?: Partial<Pick<ResourceRealizationRow, 'exists' | 'gitignored' | 'isSymlink'>>;
  /**
   * Force `contentState: 'deferred'`, `contentKey: null` — bytes nobody has
   * asked for yet. No blob row and no references are derived: a deferred
   * realization has nothing to derive them FROM, which is the whole point of
   * the state.
   */
  deferred?: boolean;
}

/** The notional line width fixture references are laid out on, so rows never overlap. */
const MAX_FIXTURE_LINE_LENGTH = 200;

/** The default syntactic form a hand-planted reference gets when unspecified. */
export const MARKDOWN_LINK: ReferenceSyntacticForm = 'markdown-link';

/**
 * The content key one fixture file's blob is filed under — derived from its
 * CONTENT, exactly as production derives it.
 *
 * ⛔ This used to hash the PATH, and that was not a harmless shortcut: it made
 * the fixture's keys one-to-one with paths, which production's never are.
 * `content-key.ts` is explicit that a key is a function of bytes and parser
 * kind alone — "two copies of the same document in different trees share a key"
 * — so `blob_references` is a per-CONTENT table, and any consumer that maps a
 * key back to "the path that wrote this" is many-to-one in the real world and
 * one-to-one here. A path-keyed fixture cannot express that shape at all, so a
 * lens that collapsed two citers into one passed every in-memory test and only
 * failed against a real tree. Keying by content is what makes those tests able
 * to fail.
 *
 * `parserKind` is `markdown` rather than `parserKindForPath`'s answer because it
 * is the truth for these rows, not a stand-in: every fixture blob is produced by
 * `parseMarkdownContent`, whatever extension the path carries.
 *
 * A `refs`-only file has no source text, so its declared references stand in as
 * its content — the only thing it is made of. Two such files declaring the same
 * references share a key, which is precisely what production would do with two
 * byte-identical files.
 *
 * @param file - The fixture file
 * @returns A schema-valid content key (`markdown.<sha256>`)
 */
function contentKeyFor(file: FixtureFile): string {
  const content = file.markdown ?? JSON.stringify(file.refs);
  return computeContentKey(Buffer.from(content, 'utf-8'), 'markdown');
}

/**
 * The `contentState` a null-or-not content key implies.
 *
 * Extracted rather than a nested ternary at the call site — `contentKey ===
 * null ? (isDirectory ? 'none' : 'deferred') : 'keyed'` reads two independent
 * questions (has a key? is it a directory?) as one expression, which is
 * exactly what `sonarjs/no-nested-conditional` flags.
 *
 * @param contentKey - The blob key, or null
 * @param isDirectory - True for a directory row
 * @returns `'keyed'` for a real key, `'none'` for a keyless directory, else `'deferred'`
 */
function contentStateFor(contentKey: string | null, isDirectory: boolean): 'keyed' | 'none' | 'deferred' {
  if (contentKey !== null) return 'keyed';
  return isDirectory ? 'none' : 'deferred';
}

/**
 * The realization row one fixture file or directory gets.
 *
 * @param resourceId - The identity this path realizes
 * @param path - Root-relative, forward-slashed path
 * @param contentKey - The blob key, or null for a directory or a `deferred` file
 * @param isDirectory - True for a directory row
 */
function realizationRow(
  resourceId: string,
  path: string,
  contentKey: string | null,
  isDirectory: boolean,
): ResourceRealizationRow {
  const lastSlash = path.lastIndexOf('/');
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dot = basename.lastIndexOf('.');
  const contentState = contentStateFor(contentKey, isDirectory);
  return {
    resourceId,
    extentId: FIXTURE_EXTENT_ID,
    path,
    pathLower: path.toLowerCase(),
    basenameLower: basename.toLowerCase(),
    dir: lastSlash === -1 ? '' : path.slice(0, lastSlash),
    // eslint-disable-next-line local/no-hardcoded-path-split -- fixture paths are authored forward-slashed, as `relativize()` emits them
    depth: path.split('/').length,
    ext: isDirectory || dot <= 0 ? '' : basename.slice(dot).toLowerCase(),
    // Typed by the SHIPPED resolver rather than a literal, so a fixture path
    // gets whatever production would give it — `CLAUDE.md` is `text/markdown`
    // here for the same reason it is there, and a path with no name in the
    // table stays honestly `null` instead of being blanket-typed by hand.
    mime: mimeTypeForPath(path),
    contentKey,
    contentState,
    mtime: null,
    exists: true,
    isDirectory,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };
}

/** The extent every fixture realization is planted under. */
const FIXTURE_EXTENT_ID = 'ctx-filesystem-fixture';

/**
 * One `blob_references` row for a HAND-PLANTED reference — the `refs` path.
 *
 * The span columns are synthesized from the ordinal so successive rows never
 * overlap; they are required by `BlobReferenceRowSchema` and this is a fixture
 * concern, not a fact about the content.
 */
function referenceRow(blob: string, ordinal: number, ref: FixtureRef): BlobReferenceRow {
  const startOffset = ordinal * MAX_FIXTURE_LINE_LENGTH;
  return {
    blob,
    ordinal,
    rawRef: ref.rawRef,
    text: null,
    line: ordinal + 1,
    column: 1,
    startOffset,
    endOffset: startOffset + ref.rawRef.length,
    syntacticForm: ref.syntacticForm ?? MARKDOWN_LINK,
    hasExtension: true,
    leadingAt: false,
    slashCount: 0,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: ref.inFence ?? false,
  };
}

/**
 * The `blob_references` rows one fixture file contributes.
 *
 * A file declaring `markdown` gets rows from the shipped producer chain, so
 * every column is whatever the real lexer computes; a file declaring `refs`
 * gets the hand-built rows instead — see `FixtureFile.markdown`'s docstring
 * for which cases each is the right tool for.
 */
function referenceRowsFor(contentKey: string, file: FixtureFile): BlobReferenceRow[] {
  if (file.markdown !== undefined) {
    const parsed = parseMarkdownContent(file.markdown, Buffer.byteLength(file.markdown));
    return blobReferencesFor(contentKey, parsed);
  }
  return file.refs.map((ref, ordinal) => referenceRow(contentKey, ordinal, ref));
}

/**
 * Add one fixture file's resource, realization, blob and reference rows to
 * the builder.
 *
 * @param builder - The builder under construction
 * @param file - The fixture file
 * @param root - The absolute root the file's identity and realization are
 *   minted against — a PARAMETER, never a module default: `closureProvenance`
 *   and `whatLoadsAt` both take `root` directly rather than reading it off a
 *   `ProjectionBase`, and a fixture that could only build against one
 *   hardcoded root could not pin that either query is parametric in it.
 */
export function addFile(builder: ProjectionBuilder, file: FixtureFile, root: string): void {
  const resourceId = builder.identities.idFor(safePath.join(root, file.path));
  builder.addResource({
    resourceId,
    kind: file.kind ?? 'file',
    origin: 'filesystem',
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });

  if (file.deferred === true) {
    builder.addRealization({
      ...realizationRow(resourceId, file.path, null, false),
      ...file.columns,
    });
    return;
  }

  const contentKey = contentKeyFor(file);
  builder.addRealization({ ...realizationRow(resourceId, file.path, contentKey, false), ...file.columns });
  for (const row of referenceRowsFor(contentKey, file)) {
    builder.addBlobReference(row);
  }
  if (file.markdown !== undefined) {
    // No harness facts here: production derives them LAZILY, for what the
    // harness reaches (`harness/harness-pass.ts`), and so does
    // {@link claudeContextFixture}. A suite testing the closure PRIMITIVE over
    // an arbitrary graph, where "every blob is derived" is the precondition,
    // uses {@link addFileWithFacts}.
    builder.addBlob(blobRowForFixture(contentKey, file.markdown));
  }
}

/**
 * {@link addFile}, plus Claude Code's facts for the file's markdown — through
 * the SHIPPED extractor, so the in-memory and on-disk lanes have one answer to
 * "which `@` is an import".
 *
 * For a suite testing the closure primitive over an arbitrary graph, whose
 * precondition is that every blob is derived. A suite about what the HARNESS
 * reaches builds with {@link claudeContextFixture}, which derives lazily as
 * production does.
 *
 * @param builder - The builder under construction
 * @param file - The fixture file
 * @param root - The absolute corpus root
 */
export function addFileWithFacts(builder: ProjectionBuilder, file: FixtureFile, root: string): void {
  addFile(builder, file, root);
  if (file.markdown === undefined || file.deferred === true) return;
  const harness = harnessRowsFor(contentKeyFor(file), CLAUDE_CODE.id, CLAUDE_CODE.factsOf(file.markdown));
  for (const row of harness.imports) builder.addHarnessBlobImport(row);
  builder.addHarnessBlobFacts(harness.facts);
}

/**
 * The `blobs` row for one fixture file's markdown, through the shipped
 * decoder and parser — never a hand-built row, so `tokenEstimate` and
 * `frontmatter` are whatever the real pipeline computes.
 *
 * @param contentKey - The blob's content key
 * @param markdown - The file's source text
 * @returns The blob row
 */
function blobRowForFixture(contentKey: string, markdown: string) {
  const bytes = Buffer.byteLength(markdown);
  const parsed = parseMarkdownContent(markdown, bytes);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `text` is discarded on purpose: it is `markdown` itself for a plain-ASCII fixture, and `decoding` is the only half `blobRowFor` wants
  const { text, ...decoding } = decodeTextContent(Buffer.from(markdown, 'utf-8'));
  return blobRowFor(contentKey, bytes, decoding, parsed);
}

/**
 * Every ancestor directory of a root-relative path, excluding the corpus root.
 *
 * @param path - Root-relative, forward-slashed path
 * @returns Ancestor directories, nearest-last
 */
function ancestorDirsOf(path: string): string[] {
  // eslint-disable-next-line local/no-hardcoded-path-split -- fixture paths are authored forward-slashed
  const segments = path.split('/');
  segments.pop();
  const dirs: string[] = [];
  for (let index = 1; index <= segments.length; index += 1) {
    dirs.push(segments.slice(0, index).join('/'));
  }
  return dirs;
}

/**
 * Every distinct ancestor directory across a set of fixture paths.
 *
 * @param paths - Root-relative fixture paths
 * @returns Distinct ancestor directories, in first-seen order
 */
function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    for (const dir of ancestorDirsOf(path)) dirs.add(dir);
  }
  return [...dirs];
}

/**
 * Add one directory's resource and realization row.
 *
 * A directory realization is never produced by `addFile`'s file-shaped
 * columns (`contentKey`, references, a blob) — it needs `isDirectory: true`
 * so `whatLoadsAt`'s file/directory split reads correctly, which is a
 * property `addFile`'s existing `kind` override (used by
 * `projection-closure-extent.test.ts` for its `DIRECTORY_FIXTURE`) does not
 * carry.
 *
 * @param builder - The builder under construction
 * @param dirPath - Root-relative directory path
 * @param root - Absolute corpus root
 */
function addDirectory(builder: ProjectionBuilder, dirPath: string, root: string): void {
  const resourceId = builder.identities.idFor(safePath.join(root, dirPath));
  builder.addResource({
    resourceId,
    kind: 'directory',
    origin: 'filesystem',
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });
  builder.addRealization(realizationRow(resourceId, dirPath, null, true));
}

/** The tables `closureProvenance` reads — see {@link closureFixtureFrom}. */
export interface ClosureFixture {
  readonly resourceRealizations: ProjectionBase['resourceRealizations'];
  readonly blobs: ProjectionBase['blobs'];
  readonly blobReferences: ProjectionBase['blobReferences'];
  readonly harnessBlobFacts: ProjectionBase['harnessBlobFacts'];
  readonly harnessBlobImports: ProjectionBase['harnessBlobImports'];
}

/**
 * A fixture for `closureProvenance`, under a caller-chosen root, built through
 * the REAL parse pipeline.
 *
 * Reuses {@link addFile} rather than hand-building rows — see
 * {@link FixtureFile.markdown}'s own docstring for why a hand-built
 * `{ rawRef, syntacticForm }` pair proves nothing about the shipped lexer. Every
 * file here is planted with `markdown` set, never `refs`, so every column
 * `closureProvenance`'s test corpus exercises — `leadingAt`, `syntacticForm`,
 * `inFence` — is whatever `parseMarkdownContent` and `blobReferencesFor` really
 * compute for the text.
 *
 * The root is a PARAMETER, not this module's {@link CLAUDE_CONTEXT_FIXTURE_ROOT}:
 * `closureProvenance` takes `input.root` directly rather than reading it off a
 * `ProjectionBase`, and a fixture that could only ever build against one
 * hardcoded root could not pin that the query is parametric in it.
 *
 * ⛔ It lives HERE rather than in `projection-closure-extent.test.ts`, where it
 * was first written. `projection-closure-provenance.test.ts` imported it from
 * that `.test.ts` file, which re-registered all 47 of that suite's cases inside
 * the provenance file: the closure-extent suite ran TWICE per `test:unit`, and
 * every test count anyone quoted was wrong. A helper two suites share belongs in
 * `test/helpers/`, which is the only directory an import cannot turn into a
 * second registration.
 *
 * @param root - The absolute corpus root every path is realized relative to
 * @param files - Root-relative path → markdown source
 * @returns Just the tables `closureProvenance` reads
 */
export function closureFixtureFrom(root: string, files: Record<string, string>): ClosureFixture {
  const builder = new ProjectionBuilder({ root });
  for (const [path, markdown] of Object.entries(files)) {
    addFileWithFacts(builder, { path, refs: [], markdown }, root);
  }
  const base = builder.base();
  return {
    resourceRealizations: base.resourceRealizations,
    blobs: base.blobs,
    blobReferences: base.blobReferences,
    harnessBlobFacts: base.harnessBlobFacts,
    harnessBlobImports: base.harnessBlobImports,
  };
}

/** Merge one contributor's rows into the builder under construction. */
function applyContribution(builder: ProjectionBuilder, contribution: ExtentContribution): void {
  for (const row of contribution.contexts) builder.addContext(row);
  for (const row of contribution.resources) builder.addResource(row);
  for (const row of contribution.realizations) builder.addRealization(row);
  for (const row of contribution.memberships) builder.addExtentMembership(row);
  for (const row of contribution.tags) builder.addTag(row);
  for (const row of contribution.conditions) builder.addCondition(row);
  // Kept in step with `mergeContribution` in `merge.ts`: this fixture bypasses
  // the driver, so a table it forgets is a table the fixture's projection is
  // silently missing while the real lane carries it.
  for (const row of contribution.claudeRulePatterns) builder.addClaudeRulePattern(row);
}

/** Rounds {@link claudeContextFixture} allows its closure stratum before calling it unsettled. */
const MAX_FIXTURE_ROUNDS = 10;

/**
 * One round of the closure stratum: the rules-scope classifier, then one
 * import extent per detected `@`-import root.
 *
 * `zone_provenance` rows are added by hand, because `contribute()` alone never
 * writes them — in the real driver (`merge.ts::runContributor`) that is the
 * MERGE layer's job, which this fixture bypasses.
 *
 * @param builder - The builder under construction
 * @param base - Its live base
 * @returns Each contribution's digest, in contributor order — the fixpoint's
 *   convergence oracle, as `merge.ts::runContributor` returns it
 */
async function contributeClosureStratum(builder: ProjectionBuilder, base: ProjectionBase): Promise<string[]> {
  const rulesScope = await new ClaudeRulesScopeContributor().contribute(base, {});
  applyContribution(builder, rulesScope);
  const digests = [extentDigest(rulesScope)];
  for (const rootRelativePath of claudeImportRootsFrom(base.resourceRealizations)) {
    const declaration = claudeImportExtentDeclaration(rootRelativePath);
    const contributor = new ClaudeImportExtentContributor(rootRelativePath);
    const contribution = await contributor.contribute(base, declaration as unknown as JsonValue);
    applyContribution(builder, contribution);
    digests.push(extentDigest(contribution));
    builder.addProvenance({
      contextId: extentContextId(CLAUDE_IMPORT_KIND, builder.identities.rootId, rootRelativePath),
      contributorId: claudeImportContributorId(rootRelativePath),
      parameterSet: declaration as unknown as JsonValue,
      extentDigest: 'fixture',
    });
  }
  return digests;
}

/**
 * A corpus root that is never touched on disk — see the module docstring.
 *
 * Exported so a suite that needs the ABSOLUTE path of a row (a rendered
 * header, for instance) can build one with
 * `safePath.join(CLAUDE_CONTEXT_FIXTURE_ROOT, row.path)` rather than
 * hardcoding a second copy of this string.
 */
export const CLAUDE_CONTEXT_FIXTURE_ROOT = '/vat-corpus/claude-context-query-fixture';

/** {@link claudeContextFixture}'s options. */
export interface ClaudeContextFixtureOptions {
  /** Paths to realize as `contentState: 'deferred'` instead of `'keyed'`. */
  readonly deferred?: readonly string[];
}

/**
 * Build a full in-memory `Projection` for the `whatLoadsAt` suite from a
 * `{path: markdown}` map.
 *
 * Runs the SHIPPED contributors over the assembled base:
 * `AgenticConventionContributor` (path classification — `claude-md`,
 * `rules-file`, `loading`), `ClaudeRulesScopeContributor` (`rule-scope`,
 * which reads `blobs.frontmatter`), and one `ClaudeImportExtentContributor`
 * per detected `@`-import root (`claudeImportRootsFrom`, the same detector
 * `buildClaudeContextPopulation` uses). That is what makes membership,
 * provenance and tags agree by construction rather than by a second,
 * hand-rolled classifier this fixture would own and could drift from the
 * shipped one.
 *
 * `zone_provenance` rows are added by hand, one per import root, because
 * `contribute()` alone never writes them — in the real driver
 * (`merge.ts::runContributor`) that is the MERGE layer's job, which this
 * fixture bypasses in favour of calling `contribute()` directly.
 *
 * @param files - Root-relative path → markdown source
 * @param options - `deferred` paths, forced to `contentState: 'deferred'`
 * @returns The populated projection
 */
export async function claudeContextFixture(
  files: Record<string, string>,
  options: ClaudeContextFixtureOptions = {},
): Promise<Projection> {
  const root = CLAUDE_CONTEXT_FIXTURE_ROOT;
  const builder = new ProjectionBuilder({ root });
  builder.addRoot({ id: builder.identities.rootId, path: root });

  const deferred = new Set(options.deferred ?? []);
  for (const [path, markdown] of Object.entries(files)) {
    addFile(builder, { path, refs: [], markdown, deferred: deferred.has(path) }, root);
  }
  for (const dir of directoriesOf(Object.keys(files))) {
    addDirectory(builder, dir, root);
  }

  // Live view: every table added above is already reflected here, and every
  // row a contributor below adds becomes visible to the NEXT contributor
  // through this same reference — see `ProjectionBuilder.base()`.
  const base: ProjectionBase = builder.base();
  const readContent: HarnessContentReader = (entry) => Promise.resolve(files[entry.path] ?? null);

  applyContribution(builder, await new AgenticConventionContributor().contribute(base, {}));

  // `merge.ts::populate`'s order, in miniature: the harness pass before the
  // closure contributors, then contributors and pass alternately until NEITHER
  // moves — `iterateClosure`'s rule. The closure contributors read facts in
  // `frontier` mode, so a member whose facts arrive in one round is followed
  // in the next; and a contributor still changing its answer is unsettled
  // whatever the pass did.
  await runHarnessPass(builder, [CLAUDE_CODE], readContent);
  let digests: readonly string[] = [];
  for (let round = 1; ; round += 1) {
    if (round > MAX_FIXTURE_ROUNDS) {
      throw new Error(`claudeContextFixture: the closure stratum was still moving after ${MAX_FIXTURE_ROUNDS} rounds.`);
    }
    const next = await contributeClosureStratum(builder, base);
    const { derived } = await runHarnessPass(builder, [CLAUDE_CODE], readContent);
    const contributorsMoved = next.join('\0') !== digests.join('\0');
    digests = next;
    if (derived === 0 && !contributorsMoved) break;
  }
  // The producer's own post-populate guard: every blob the harness reaches has
  // its facts. Nothing the fixture's reader is handed can be unreadable.
  assertHarnessSettled(builder.base(), [CLAUDE_CODE], new Set());

  return builder.build();
}
