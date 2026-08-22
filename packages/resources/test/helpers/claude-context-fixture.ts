/**
 * Fixture machinery for the projection query suites — shared by
 * `projection-closure-extent.test.ts`, `projection-closure-provenance.test.ts`
 * and `projection-claude-context-query.test.ts`.
 *
 * ## `addFile` lives here, and only here
 *
 * Plan A's Task 1 established that a synthetic `{ rawRef, syntacticForm }` pair
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
 * the filesystem, and `ABSENT_ROOT` is what makes that a testable claim rather
 * than an assertion: if a resolution path ever started `stat`-ing, a fixture
 * rooted at a real directory would never catch it. `whatLoadsAt` inherits the
 * same claim — it reads only materialised tables — so it gets the same root.
 */

import { createHash } from 'node:crypto';

import { safePath } from '@vibe-agent-toolkit/utils';
import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';

import { parseMarkdownContent } from '../../src/link-parser.js';
import { blobRowFor } from '../../src/projection/blob-facts.js';
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

/** A schema-valid content key (`<parserKind>.<sha256>`) derived from a seed. */
function markdownKey(seed: string): string {
  return `markdown.${createHash('sha256').update(seed).digest('hex')}`;
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

  const contentKey = markdownKey(file.path);
  builder.addRealization({ ...realizationRow(resourceId, file.path, contentKey, false), ...file.columns });
  for (const row of referenceRowsFor(contentKey, file)) {
    builder.addBlobReference(row);
  }
  if (file.markdown !== undefined) {
    builder.addBlob(blobRowForFixture(contentKey, file.markdown));
  }
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

/** The two tables `closureProvenance` reads — see {@link closureFixtureFrom}. */
export interface ClosureFixture {
  readonly resourceRealizations: ProjectionBase['resourceRealizations'];
  readonly blobReferences: ProjectionBase['blobReferences'];
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
 * The root is a PARAMETER, not this module's {@link ABSENT_ROOT}:
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
 * @returns Just the two tables `closureProvenance` reads
 */
export function closureFixtureFrom(root: string, files: Record<string, string>): ClosureFixture {
  const builder = new ProjectionBuilder(root);
  for (const [path, markdown] of Object.entries(files)) {
    addFile(builder, { path, refs: [], markdown }, root);
  }
  const base = builder.base();
  return { resourceRealizations: base.resourceRealizations, blobReferences: base.blobReferences };
}

/** Merge one contributor's rows into the builder under construction. */
function applyContribution(builder: ProjectionBuilder, contribution: ExtentContribution): void {
  for (const row of contribution.contexts) builder.addContext(row);
  for (const row of contribution.resources) builder.addResource(row);
  for (const row of contribution.realizations) builder.addRealization(row);
  for (const row of contribution.memberships) builder.addExtentMembership(row);
  for (const row of contribution.tags) builder.addTag(row);
  for (const row of contribution.conditions) builder.addCondition(row);
}

/** A corpus root that is never touched on disk — see the module docstring. */
const ABSENT_ROOT = '/vat-corpus/claude-context-query-fixture';

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
  const root = ABSENT_ROOT;
  const builder = new ProjectionBuilder(root);
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

  applyContribution(builder, await new AgenticConventionContributor().contribute(base, {}));
  // Reads `base.blobs`, so it must run after every blob row above is in.
  applyContribution(builder, await new ClaudeRulesScopeContributor().contribute(base, {}));

  for (const rootRelativePath of claudeImportRootsFrom(base.resourceRealizations)) {
    const declaration = claudeImportExtentDeclaration(rootRelativePath);
    const contributor = new ClaudeImportExtentContributor(rootRelativePath);
    const contribution = await contributor.contribute(base, declaration as unknown as JsonValue);
    applyContribution(builder, contribution);
    builder.addProvenance({
      contextId: extentContextId(CLAUDE_IMPORT_KIND, builder.identities.rootId, rootRelativePath),
      contributorId: claudeImportContributorId(rootRelativePath),
      parameterSet: declaration as unknown as JsonValue,
      extentDigest: 'fixture',
    });
  }

  return builder.build();
}
