/**
 * @vibe-agent-toolkit/resources
 *
 * Markdown resource parsing, validation, and link integrity checking.
 *
 * This package provides comprehensive tools for managing collections of markdown resources,
 * extracting links and headings, validating link integrity, and tracking resource relationships.
 *
 * @packageDocumentation
 *
 * @example Basic usage with ResourceRegistry
 * ```typescript
 * import { ResourceRegistry } from '@vibe-agent-toolkit/resources';
 *
 * const registry = new ResourceRegistry();
 *
 * // Add resources
 * await registry.addResource('./README.md');
 * await registry.crawl({ baseDir: './docs' });
 *
 * // Validate all links
 * const result = await registry.validate();
 * if (!result.passed) {
 *   console.error(`Found ${result.errorCount} broken links`);
 * }
 * ```
 */

// Type-only, so it is erased and does NOT pull the parser into this barrel's
// module graph — which is the whole point of the lazy `parseMarkdown` /
// `parseHtml` wrappers below.
import type { ParseResult } from './link-parser.js';
// A value import, and NOT part of the public surface: the two lazy parse wrappers
// below import a parser module by a route `loadParser` does not cover, and must
// produce the same `ParserUnavailableError` when it cannot be loaded. `parse-cache`
// is already in this barrel's graph (it is value-re-exported below) and pulls in no
// parser of its own, so this costs nothing at load time.
import { importParserModule } from './parse-cache.js';

// Export main ResourceRegistry class and ID generation utility
export {
  ResourceRegistry,
  DEFAULT_RESOURCE_INCLUDE,
  // Exported so a caller can catch it BY TYPE. `addResource` (singular) signals
  // a first-added-wins collision only by throwing, and the one consumer that
  // handles it was sniffing `error.message.startsWith('Duplicate resource ID')`
  // — a check that silently stops matching the day the message is reworded.
  DuplicateResourceIdError,
  generateIdFromPath,
  // What a resource is when `parserKindForPath` answers `none`. Exported for
  // the CLI's parse-fact snapshot, which routes by the same discriminator and
  // must not re-implement the shape — see the function's own docstring for why
  // this is the one export and not an invitation.
  unparsedResourceFacts,
  type CrawlOptions,
  type DuplicateIdCollision,
  type UnreadableResource,
  type ResourceRegistryOptions,
  type RegistryStats,
  type CollectionStats,
  type CollectionStat,
} from './resource-registry.js';

// Export ResourceQuery for lazy evaluation and filtering
export { ResourceQuery } from './resource-query.js';

// Export ResourceCollection for immutable collections with lazy duplicate detection
export { ResourceCollection } from './resource-collection.js';

// Export ResourceCollectionInterface for collection behavior
export type { ResourceCollectionInterface } from './resource-collection-interface.js';

// Export DeferredArtifacts model for `files:` deferred build-artifact detection
export { DeferredArtifacts, type DeferredSkillFiles } from './deferred-artifacts.js';

// Export all type definitions (from schemas)
export type {
  LinkNodeType,
  LinkType,
  HeadingNode,
  ResourceLink,
  ResourceMetadata,
  ValidationIssue,
  ValidationResult,
  ProjectConfig,
  ResourcesConfig,
  CollectionConfig,
  CollectionValidation,
  ValidationMode,
  SkillFileEntry,
  SkillPackagingConfig,
  SkillsConfig,
  ClaudeConfig,
  ClaudeMarketplaceConfig,
  ClaudeMarketplacePluginEntry,
  ExternalPluginSource,
} from './types.js';

// Export schemas for external use (e.g., JSON Schema generation, runtime validation)
export {
  LinkNodeTypeSchema,
  LinkTypeSchema,
  HeadingNodeSchema,
  ResourceLinkSchema,
  ResourceMetadataSchema,
} from './schemas/resource-metadata.js';

export {
  ValidationIssueSchema,
  ValidationResultSchema,
} from './schemas/validation-result.js';

// Projection schema v3 — zones (docs/architecture/zones.md) plus demand-driven
// content keying (`contentState`).
// The blob-keyed and path-dependent tables that make up VAT's queryable
// resource projection contract. Population is still proposed.
export {
  ContentKeySchema,
  JsonValueSchema,
  ProjectionConditionSeveritySchema,
  type JsonValue,
  type ProjectionConditionSeverity,
} from './schemas/projection-shared.js';

export {
  BlobConditionRowSchema,
  BlobEncodingSchema,
  BlobEncodingSourceSchema,
  BlobReferenceRowSchema,
  BlobRowSchema,
  BlobSectionRowSchema,
  ReferenceSyntacticFormSchema,
  VariableExpansionSyntaxSchema,
  type BlobConditionRow,
  type BlobReferenceRow,
  type BlobRow,
  type BlobSectionRow,
  type ReferenceSyntacticForm,
  type VariableExpansionSyntax,
} from './schemas/projection-blobs.js';

export {
  LensEntryPointRowSchema,
  ResolutionContextRowSchema,
  TreeRoleSchema,
  ZoneKindSchema,
  ZoneProvenanceRowSchema,
  ZoneSpeciesSchema,
  type LensEntryPointRow,
  type ResolutionContextRow,
  type TreeRole,
  type ZoneProvenanceRow,
  type ZoneSpecies,
} from './schemas/projection-zones.js';

export {
  CONDITION_WITHOUT_REFERENCE,
  ContentStateSchema,
  RealizationConditionRowSchema,
  ResourceExtentRowSchema,
  ResourceKindSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  ResourceTagSourceSchema,
  RootRowSchema,
  type ContentState,
  type RealizationConditionRow,
  type ResourceExtentRow,
  type ResourceRealizationRow,
  type ResourceRow,
  type ResourceTagRow,
  type RootRow,
} from './schemas/projection-resources.js';

export {
  EdgeKindSchema,
  EdgeOriginSchema,
  EdgeResolutionRowSchema,
  EdgeRowSchema,
  type EdgeOrigin,
  type EdgeResolutionRow,
  type EdgeRow,
} from './schemas/projection-edges.js';

// Projection substrate — population, not schema. `resource_realizations` rows
// for one path in one extent, plus the two path primitives every population
// pass and every enumeration instrument shares.
// Also the run's parse routing. `createCollectionMimeResolver` is exported for a
// caller assembling a population by hand and for the tests that drive routing
// directly — `populate()` builds one from `PopulateOptions.collections` for
// every ordinary caller, and that ONE instance is what the conflict accumulator
// depends on. `COLLECTION_MIME_CONFLICT` and its row builder go with it because
// a consumer that wants to FAIL on a config error needs the code to match on.
export {
  collectionMimeConflictCondition,
  collectRealization,
  createCollectionMimeResolver,
  realPathOrNull,
  relativize,
  COLLECTION_MIME_CONFLICT,
  NO_DECLARED_MIME_TYPES,
  type CollectionMimeConflict,
  type CollectionMimeResolver,
  type ContentDemand,
  type PathShape,
  type RealizationContext,
} from './projection/realizations.js';

// The per-run content cache: one `readFile` + one SHA-256 per file per
// population, however many extents realize it and whether or not the blob stage
// then parses it. Threaded through the run and never a module global — its
// lifetime is one `ProjectionBuilder`, because two populations of a changed tree
// sharing bytes would describe the wrong corpus confidently.
export {
  RunContentCache,
  readKeyedContent,
  type ContentCacheStats,
} from './projection/content-cache.js';

// Blob-keyed section rows, and the heading-tree flattener they share with the
// parse-fact oracle — exported so exactly one walk defines document order.
export { blobSectionsFor, flattenHeadings } from './projection/blob-sections.js';

// The projection container: twelve row tables, the builder that accumulates
// them, and the read-only base view a contributor is handed. The builder's
// `ensureContentKey` is the demand half of demand-driven keying — the only way
// a `deferred` realization's null `contentKey` ever becomes a real one.
// A read it makes that THROWS is `REALIZATION_PROMOTION_UNREADABLE`: the blob
// layer's `BLOB_UNREADABLE` one tier down, and the row that stops a failed
// promotion looking like a promotion nobody asked for.
export {
  ProjectionBuilder,
  REALIZATION_PATH_COLLISION,
  REALIZATION_PROMOTION_UNREADABLE,
  type Projection,
  type ProjectionBase,
} from './projection/projection.js';

// The table registry: the single authority on table name → row schema → primary
// key → column order. `exportProjection`'s sort keys and the committed JSON
// Schemas are both derived from it, and any storage backend that writes the
// projection out reads it rather than restating a fourth list.
export {
  PROJECTION_TABLES,
  type ProjectionRow,
  type ProjectionTableName,
  type ProjectionTableScope,
  type ProjectionTableSpec,
} from './projection/table-registry.js';

// What each column holds, read out of the row schema. Every storage backend
// needs it — Arrow needs a type per vector, SQL needs one per column — so the
// classification lives beside the registry rather than once per backend.
export {
  type ProjectionColumnKind,
  type ProjectionColumnSource,
  type ProjectionColumnType,
  type ProjectionColumnTypeSource,
  projectionColumnType,
  projectionColumnTypes,
  projectionRowShape,
} from './projection/column-kinds.js';

// The pluggable storage seam. Stated in the projection's own vocabulary — facts
// about blobs, the extent of a tree — so each backend owns its physical
// strategy instead of inheriting another's.
export {
  type BlobScopedRows,
  type BlobScopedTableName,
  type ExtentKey,
  type ExtentScopedRows,
  type ExtentScopedTableName,
  type ProjectionStore,
  type ProjectionTableNamesOfScope,
  projectionShapeDigest,
  splitProjectionByScope,
} from './projection/store.js';

// The reuse rule over that seam: whether a stored extent answers THIS run's
// question, and how a projection is put back together from the rows that do.
// Exported because it is the half a second backend must not be free to
// reinterpret — a store holds rows, this decides what they are worth.
export {
  assembleProjection,
  blobFactsCover,
  emptyBlobRows,
  keyedContentKeys,
  selectRequestedContexts,
  selectRequestedRows,
  type RequestedContributor,
} from './projection/store-hydration.js';

// How the registry's names are spelled inside SQL — one rule, beside the
// registry that mints them.
export { quoteIdentifier } from './projection/sql-identifiers.js';

// Lexical reference extraction: reference candidates the markdown AST cannot
// see (@-prefixed tokens, variable-anchored paths, bounded bare tokens).
export {
  codeContextRangesFrom,
  detectVariableExpansion,
  findLexicalReferences,
  type CodeContextRanges,
  type OffsetRange,
} from './reference-lexer.js';
// The three capabilities VAT wants from a parser. Types plus one error class —
// no implementation is reachable from here, so the barrel stays parser-free.
export {
  MissingCapabilityError,
  type FlatHeading,
  type MarkdownParser,
  type ParseCapability,
  type ParseSession,
  type SourceSpan,
  type SpanFacts,
  type SpanKind,
  type StructureFacts,
} from './parse-capabilities.js';
// `LexicalReference` and `ContentMeasures` are Zod-sourced (single source of
// truth) — see schemas/parse-facts.ts, which is also what the parse cache
// validates an entry against.
export type { ContentMeasures, LexicalReference } from './schemas/parse-facts.js';

// Export parser interface for advanced use cases
export type { ParseResult } from './link-parser.js';
export { classifyLink, isLocalFileLink } from './link-classify.js';
// ⛔ `createMarkdownProcessor` is deliberately NOT re-exported here. It reaches
// remark statically, and this barrel is loaded by commands that must never pay
// for the parser — `module-load-budget.integration.test.ts` fails the moment it
// does. Consumers that genuinely want the processor import the
// `./markdown-processor` subpath, which is exported for exactly that reason.

/**
 * Parse a markdown file from disk.
 *
 * ## Why this is a wrapper and not `export { parseMarkdown } from ...`
 *
 * A value re-export makes the parser part of this barrel's module graph, so
 * importing ANY symbol from `@vibe-agent-toolkit/resources` evaluated the whole
 * remark stack — ~730ms on Windows — before a single line of caller code ran.
 * Every consumer reaches this package through the barrel (the package publishes
 * only `"."` and `"./schemas/*"`), so that cost was unavoidable and it silently
 * cancelled the parser deferral in `parse-cache.ts`: a fully warm scan, which
 * parses nothing, still paid for the parser.
 *
 * Deferring it here instead of dropping the export keeps the public signature
 * byte-identical — this function was already `async`, so a caller cannot tell
 * the difference — and needs no `exports` subpath.
 *
 * ⚠️ Keep this a wrapper. Restoring the plain re-export re-loads remark for
 * every consumer of every symbol in this package and is invisible in review;
 * `packages/cli/test/integration/module-load-budget.integration.test.ts` is
 * what fails if you do.
 *
 * ## Why the import goes through `importParserModule`
 *
 * This route bypasses `loadParser` entirely — it reads the file itself, so it
 * needs `parseMarkdown` rather than `parseMarkdownContent` — and it therefore
 * has its own `import()` that can fail its own way. Unwrapped, a broken install
 * reached this package's consumers as a bare `EACCES`, which every per-document
 * catch and every errno allow-list in the toolkit swallows. `importParserModule`
 * makes it the same `ParserUnavailableError` the cached route produces, so one
 * `isParserUnavailable` guard at a call site covers both. The parse call itself
 * is deliberately OUTSIDE that boundary: a document that will not parse is not a
 * broken install.
 *
 * @param filePath - Path to the markdown file
 * @returns Links, headings, frontmatter and measures for the document
 * @throws {ParserUnavailableError} If the parser module cannot be loaded
 */
export async function parseMarkdown(filePath: string): Promise<ParseResult> {
  const parse = await importParserModule(
    'markdown',
    async () => (await import('./link-parser.js')).parseMarkdown,
  );
  return parse(filePath);
}

// The content-decoding seam is NOT re-exported here. It is a `utils` primitive
// (`@vibe-agent-toolkit/utils/text` for `decodeTextContent`,
// `@vibe-agent-toolkit/utils/fs` for `readTextContent`), and an adopter who
// wants "read a file, decode it" should not have to depend on the projection
// layer to get it. `readContentWithKey` below is what this package adds: the
// decode COMPOSED with a raw-bytes content key.

// Parse identity: which parser a path routes to, and the key a parse result is
// filed under. Path-independent by construction — see content-key.ts.
//
// `ParserKind` has three members: `markdown`, `html`, and `none` for "no
// document parser runs on this". `DocumentParserKind` (from mime-type.ts) is the
// first two — the kinds a parser actually exists for — and it is what
// `parseFileCached`, `loadParser` and `parseKeyed` accept. `isParsableContent`
// is the narrowing between them, and is exported because there is no other way
// for a caller holding a path-routed blob to reach the parse path.
export {
  computeContentKey,
  isParsableContent,
  parserKindForPath,
  readContentWithKey,
  type KeyedContent,
  type ParsableContent,
  type ParserKind,
} from './content-key.js';
export type { DocumentParserKind } from './mime-type.js';

// Parse cache: the disk-backed store `ResourceRegistry` files parse facts in,
// and where it puts them. Exported for two callers only — an operator surface
// that reclaims the space (`vat cache clear` needs `clear()` and a path to name
// in its output), and a test or embedder that wants the registry pointed at a
// private directory via `ResourceRegistryOptions.parseCache`.
//
// `dehydrate` / `rehydrate` / `ParseFacts` are
// deliberately NOT re-exported here: they are the on-disk serialization, the
// same category as the link-parser internals this file already withholds (see
// the note further down). Nothing outside the cache should be able to mint or
// read an entry payload — a well-formed entry filed under the wrong key is the
// one failure mode fail-soft IO handling cannot catch.
//
// `parseFileCached` IS exported, and is the one every caller outside
// `ResourceRegistry` should reach for: `parseMarkdown`/`parseHtml` read the file
// and hand the bytes straight to a parser, so they bypass the cache entirely.
//
// `isParserUnavailable` and `ParserUnavailableError` are exported for one narrow
// purpose: a caller that wraps a parse in a per-document `try` must rethrow this
// one type, or its catch silently reports a broken INSTALL as a broken DOCUMENT —
// once per document. The parser is loaded lazily, past the parse cache's hit-path
// return (a fully warm run must load no parser at all), so the load happens INSIDE
// those trys by design and position cannot be the guard.
//
// The type also carries a `code` no errno allow-list holds, which is what gets a
// broken install past the boundaries one layer further out — `vat audit`'s scan
// catch, `ResourceRegistry`'s read-failure demotion — that would otherwise degrade
// it to a warning and exit 0. Those two need no predicate call for that reason;
// only a catch that swallows EVERYTHING does.
//
// `loadParser` is exported for tests and embedders that want to force or observe
// the load. ⛔ It is NOT an optimisation hook: awaiting it before a loop, to "warm"
// the parser, is exactly the regression above.
export {
  ParseCache,
  ParserUnavailableError,
  defaultParseCache,
  isParserUnavailable,
  loadParser,
  parseCacheDirectory,
  parseFileCached,
  parseKeyed,
  vatCacheNamespace,
  vatCacheNamespaceRoot,
  vatCacheRoot,
  type LoadedParser,
  type ParseCacheOptions,
  type ParseCacheStats,
} from './parse-cache.js';

/**
 * Parse an HTML file from disk.
 *
 * Lazy for the same reason as {@link parseMarkdown} above — a value re-export
 * put parse5 in this barrel's module graph for every consumer of every symbol.
 * The signature is unchanged; it was already `async`. The load goes through
 * `importParserModule` for the same reason too: an `.html`-only corpus must
 * report a broken install as a broken install, and this is the only route by
 * which it ever loads a parser.
 *
 * @param filePath - Path to the HTML file
 * @returns Links, headings and measures for the document
 * @throws {ParserUnavailableError} If the parser module cannot be loaded
 */
export async function parseHtml(filePath: string): Promise<ParseResult> {
  const parse = await importParserModule(
    'html',
    async () => (await import('./html-link-parser.js')).parseHtml,
  );
  return parse(filePath);
}

// HtmlParseError is Zod-sourced (single source of truth) — see schemas/resource-metadata.ts.
export type { HtmlParseError } from './schemas/resource-metadata.js';
export { rewriteHtmlLinks, type UnappliedRewrite } from './html-transform.js';

// Export frontmatter validation. `compileFrontmatterSchema` +
// `validateCompiledFrontmatter` is the form to use when validating many
// documents against one schema — `validateFrontmatter` compiles per call.
export {
  compileFrontmatterSchema,
  validateCompiledFrontmatter,
  validateFrontmatter,
  type CompiledFrontmatterSchema,
} from './frontmatter-validator.js';

// Public Ajv factory for adopters consuming VAT-generated schemas. Registers
// URI-family formats (uri, uri-reference, iri, iri-reference) so schemas
// compile cleanly under Ajv strict mode without throwing on "unknown format".
export { createAjvWithUriFormats } from './ajv-factory.js';

// Export content transform engine for link rewriting
export {
  transformContent,
  type ContentTransformOptions,
  type LinkRewriteMatch,
  type LinkRewriteRule,
  type ResourceLookup,
} from './content-transform.js';

// Note: link-parser and link-validator internals are NOT exported
// They are implementation details. Users should use ResourceRegistry API.

// Export href resolution utility (shared by audit and validate code paths)
export { resolveLocalHref, type ResolveLocalHrefResult } from './utils.js';

// Export frontmatter editor primitive (comment-preserving round-trip)
export {
  openFrontmatter,
  FrontmatterParseError,
  type FrontmatterEditor,
} from './frontmatter-editor.js';

// Export rewriter helpers (built on FrontmatterEditor + shared callback shape)
export {
  rewriteFrontmatterUriReferencesFromSchema,
  rewriteFrontmatterFieldsAtPaths,
  rewriteBodyLinks,
  type RewriteHref,
} from './rewriter-helpers.js';

// Export project config parsing
export {
  parseConfigFile,
  loadConfig,
} from './config-parser.js';

export {
  ProjectConfigSchema,
  SkillExecutableEntrySchema,
  SkillFileEntrySchema,
  SkillsConfigSchema,
  SkillPackagingConfigSchema,
  SkillSourceDescriptorSchema,
  TestConfigSchema,
  type SkillExecutableEntry,
  type SkillSourceDescriptor,
  type TestConfig,
} from './schemas/project-config.js';

// linkAuth content-fetch primitive (issue #113 slice 3). Ships standalone;
// callers wire it into asset-reference / bundling consumers as they need.
export {
  fetchAuthenticated,
  type ContentFetchResult,
  type FetchAuthenticatedOptions,
} from './link-auth-content-fetch.js';

export { ContentCache } from './content-cache.js';
// `ContentMetadata` is Zod-sourced (single source of truth) — see
// schemas/content-cache.ts, which is also what the content cache validates a
// stored entry against on read.
export type { ContentMetadata } from './schemas/content-cache.js';

// Token-resolution memo wrapper. High-volume callers iterating many URLs
// from the same provider wrap their deps once and reuse the result, so
// expensive token sources (`gh auth token` etc.) run at most once.
export {
  wrapLinkAuthDepsWithMemo,
  type LinkAuthDeps,
} from './link-auth-deps-memo.js';

// Bridge from adopter `resources.linkAuth` (Zod-validated) to the engine's
// `LinkAuthConfig` (fully-expanded providers). Adopters carrying a parsed
// config can hand it directly to `fetchAuthenticated` via this bridge.
export { buildLinkAuthEngineConfig } from './link-auth-config-build.js';

// linkAuth pure engine — public API only (issue #113).
// Internal helpers (rewrite, build-headers, etc.) stay module-private.
export {
  type LinkAuthConfig,
  type Provider,
  type ProviderAuth,
  type ProviderCheck,
  resolveAuthenticatedUrl,
  type ResolveOutcome,
} from './link-auth/resolve.js';
export type { ProviderMatch } from './link-auth/select-provider.js';
export type { RewriteRule } from './link-auth/rewrite.js';
export { defaultRunCommand, type TokenSource } from './link-auth/resolve-token.js';
export { expandMacro, UnknownMacroError } from './link-auth/expand-macro.js';

// The extent-contributor seam (zones §7.1/§7.4/§7.5): the interface every
// extent contributor implements, the registry the merge driver partitions by
// stratum, and the required extent digest that makes two populations
// comparable. `ProjectionBase` is deliberately NOT re-exported on this line —
// it belongs to the projection container's declaration.
export {
  ContributorRegistry,
  extentDigest,
  type ContributorStratum,
  type ExtentContribution,
  type ExtentContributor,
} from './projection/contributor.js';

// Blob-keyed reference rows — a parser AST's links (mdast or parse5) and the
// raw-source lexer's tokens unified into one position-ordered ordinal space.
//
// `AST_SYNTACTIC_FORMS` and `hasReferenceSpan` are exported because they are
// the producer's own answers to "which rows came from a parser?" and "which
// links could become rows at all?". A consumer that reconstructs either by hand
// is a second opinion that goes stale the next time a parser is added — which
// is exactly how a hand-listed markdown triple made a whole-corpus invariant
// disagree with its own counter once HTML references started producing rows.
export {
  AST_SYNTACTIC_FORMS,
  blobReferencesFor,
  hasReferenceSpan,
  type PositionedLink,
} from './projection/blob-references.js';

// The filesystem extent (zones §2): everything on disk under the root, files
// AND directories, excluding NEVER_CRAWL_GLOBS but deliberately NOT build
// output — this is the extent that sees what the git extent cannot.
export { FilesystemExtentContributor } from './projection/contributors/filesystem-extent.js';

// The agentic-convention classifier and its producer — the first contributor
// that answers "what IS this file" rather than "does it exist".
//
// ⚠️ No longer the ONLY producer of `resource_tags`: `ClaudeRulesScopeContributor`
// files `rule-scope` rows from the `closure` stratum, because the fact it
// classifies on lives in frontmatter and `blobs` does not exist until after
// `base` has run. It is still the only producer of `loading`, deliberately — see
// that module for why a second one would end the one-loading-row-per-identity
// invariant `strongestLoading` exists to hold.
export { AgenticConventionContributor } from './projection/contributors/agentic-convention.js';
export {
  CLAUDE_MD_TAG,
  classifyPath,
  LOADING_TAG,
  pluginRootsFrom,
  RULES_FILE_TAG,
  strongestLoading,
} from './projection/agentic-tags.js';
export type { AgenticTag, PluginRoots, TagLoading } from './projection/agentic-tags.js';

// The Claude `@`-import closure: one extent per `CLAUDE.md` / `.claude/rules`
// root, the roots discovered through `classifyPath` rather than a second glob.
export {
  CLAUDE_IMPORT_CONTRIBUTOR_ID_PREFIX,
  CLAUDE_IMPORT_KIND,
  ClaudeImportExtentContributor,
  claudeImportContributorId,
  claudeImportExtentDeclaration,
  claudeImportRootsFrom,
} from './projection/contributors/claude-import-extent.js';

// The `rule-scope` producer: the frontmatter fact `classifyPath` structurally
// cannot see, since it runs in `base` and `blobs` does not exist until after.
export {
  CLAUDE_RULES_SCOPE_KIND,
  ClaudeRulesScopeContributor,
  RULE_SCOPE_TAG,
  ruleScopeFor,
} from './projection/contributors/claude-rules-scope.js';
export type { RuleScope } from './projection/contributors/claude-rules-scope.js';

// The lane that assembles the three above. Its own lane, not a flag on the fast
// repo-wide one: that one declares CONTENT_PARSING_SKIP and both classifiers
// here read blob-keyed tables.
export { buildClaudeContextPopulation } from './projection/claude-context-population.js';

// The §6 query over that lane's projection — "what loads at this path, and why".
// `claudeAncestry` and `selectRules` are deliberately NOT exported: they are this
// function's internals, nothing outside the package calls them, and pre-1.0 an
// unexported symbol costs nothing while a published one is a contract.
export {
  whatLoadsAt,
  type Admission,
  type GradedCondition,
  type LoadClass,
  type LoadedContext,
  type LoadedContextAnswer,
  type LoadedRow,
} from './projection/claude-context-query.js';

// What the harness actually CHARGES for what the query says is loaded — the
// 4 MiB `CLAUDE.md` cliff, the subtree it prunes behind it, and the counters that
// stop a sum being read as the whole story.
// `OVERSIZE_BYTES` is deliberately NOT among them: the cliff is `account`'s to
// apply, no consumer re-derives it, and the one test that needs the boundary
// imports it from the module directly. Pre-1.0, an unexported symbol costs
// nothing while a published one is a contract.
export {
  account,
  type AccountedContext,
  type AccountedRow,
  type ChargeState,
  type ContextTotals,
} from './projection/claude-context-accounting.js';

// The always-loaded budget over those charges — VAT's flagship projection check,
// as a pure predicate. The threshold constant IS exported (unlike `OVERSIZE_BYTES`
// above) because the CLI's config default reads it: a number the command
// re-spelled would be a second copy of a measured quantity.
export {
  DEFAULT_ALWAYS_LOADED_CONTEXT_TOKENS,
  alwaysLoadedBudget,
  type AlwaysLoadedBudget,
  type BudgetContributor,
} from './projection/claude-context-budget.js';

// That budget over the WHOLE tree, from one query per distinct instruction chain
// rather than one per directory — 9 queries instead of 589 on VAT's own corpus.
// The internals (`representativeFor`, `workingLocations`) stay unexported for the
// reason `selectRules` does: pre-1.0, a published symbol is a contract, and the
// collapse's soundness is guarded by the suite's differential oracle rather than
// by anyone calling its pieces.
export {
  sweepAlwaysLoadedBudgets,
  type BudgetSweep,
  type LocationBudget,
} from './projection/claude-context-budget-sweep.js';

// The same collapse WITHOUT a threshold: what it costs to work in each part of a
// tree. `vat claude context --all` used to answer every realized path — 10,438
// answers and 205,918 lines on one adopter tree, which is a report nobody can
// read and an agent cannot afford. This reports the always-loaded floor once per
// distinct instruction chain, and the on-demand burden per DIRECTORY, because
// only the first of those two collapses.
//
// ⛔ `contextRegions` is exported and `sweepAlwaysLoadedBudgets`' internals still
// are not, and the asymmetry is deliberate: the region model now has TWO callers
// inside this package, so it is a real seam rather than one lane's private
// helper. Its soundness is still guarded by the suite's differential oracle.
export {
  buildContextCostMap,
  type ContextCostMap,
  type DirectoryCost,
  type RegionCost,
  type UnmeasuredRowCounts,
} from './projection/claude-context-cost-map.js';
export {
  contextRegions,
  type ContextRegion,
} from './projection/claude-context-regions.js';

// The COMPLEMENT of the query: what the loaded set POINTS AT in one hop and the
// harness does not load. Its own row shape on purpose — a voluntary markdown link
// has no honest `loadClass`, and folding it into `LoadedRow` would make the
// on-demand total un-addable. The two answers partition: a target already in the
// loaded set is excluded here.
// The internals (`hasUriScheme`, `resolveTarget`) stay unexported for the same
// reason `selectRules` does — pre-1.0, a published symbol is a contract.
export {
  discoverableFrom,
  type DiscoverableContext,
  type DiscoverableRow,
  type DiscoveryCitation,
  type DiscoveryReach,
  type DiscoveryTotals,
} from './projection/claude-context-discovery.js';

// What the answer deliberately does not settle, as DATA rather than prose in a
// doc: the command prints these beside every number, because a limit a reader has
// to go and find is a limit that never reaches the person acting on the number.
// The bounds statement ships WITH the list, so a consumer that renders the limits
// cannot reach them without also reaching the sentence that frames them.
export {
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  CLAUDE_CONTEXT_LIMITS,
  CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
  type ModelledBehaviour,
  type StatedLimit,
} from './projection/claude-context-limits.js';

// The same discipline for the half of the lane that GATES. `vat claude budget`
// applies a threshold to the measurement `vat claude context` reports, so it owes
// a reader the same signed bounds — COMPOSED from the list above by id rather
// than copied, plus the four that only a thresholded reading needs.
export {
  ALWAYS_LOADED_BUDGET_LIMITS,
  BUDGET_LIMIT_IDS_FROM_CONTEXT,
  limitsById,
} from './projection/claude-context-budget-limits.js';

// One crawl API, two implementations (scanning-and-caching §3.3): the walk, and
// git plus a bounded walk of only what git cannot see. Same population, two cost
// models — which is exactly what makes them differentially testable.
export {
  crawlSourceFor,
  EXTENT_SOURCE_ENV,
  EXTENT_SOURCE_FILESYSTEM,
  EXTENT_SOURCE_GIT,
  FilesystemCrawlSource,
  gitExtentSelected,
  GitCrawlSource,
  type CrawlSource,
  type CrawlSourceKind,
  type EnumeratedPath,
} from './projection/crawl-source.js';

// The resources lane's population, sourced from that extent instead of from
// `git ls-files` — which is what lets `vat resources validate` see a markdown
// file the author has written but not yet committed.
export {
  buildResourcePopulation,
  type ResourcePopulation,
  type ResourcePopulationSource,
} from './projection/resource-population.js';

// The git extent (zones §2): tracked ∪ (untracked ∧ ¬ignored) — what a clone
// sees. Its disagreement with the filesystem extent over a gitignored path is
// the visible-to-you/invisible-to-CI fact, not an inconsistency.
export {
  GIT_EXTENT_CONTRIBUTOR_ID,
  GIT_EXTENT_KIND,
  GIT_EXTENT_ORIGIN,
  GitExtentContributor,
} from './projection/contributors/git-extent.js';

// The one spelling of an extent's `resolution_contexts.contextId`. Every extent
// id carries its root, so two federated roots' same-kind (and same-package)
// extents cannot collide in a table keyed on `contextId` alone.
export { extentContextId } from './projection/contributors/context-id.js';

// The package extent: the workspace's own packages plus declared dependencies,
// located by resolution through each package's `exports` map — never by walking
// `node_modules`. A dependency that is declared but not installed contributes a
// resource with ZERO realizations, which is the "known but not present" case.
export {
  PACKAGE_NOT_INSTALLED,
  PACKAGE_RESOLUTION_FAILED,
  PACKAGE_SUBPATH_ABSENT,
  PACKAGE_SUBPATH_NOT_EXPORTED,
  PackageExtentContributor,
  PackageExtentParametersSchema,
  type PackageExtentParameters,
} from './projection/contributors/package-extent.js';

// The stratified merge driver (zones §7.2): base contributors run once, closure
// contributors iterate to a fixed point under a declared cap, and a cap that is
// reached while digests are still moving THROWS rather than returning the
// truncated extent it had reached.
//
// It also owns the post-fixpoint re-run of the blob stage: demand-driven keying
// means a `deferred` realization can become `keyed` during the closure stratum,
// and `BlobPopulationReport` reports that second run as its own measurement
// rather than summing counters that have no honest combination rule.
export {
  CONTENT_PARSING_DERIVE,
  CONTENT_PARSING_SKIP,
  ClosureNonConvergenceError,
  DISCARD_BLOB_POPULATION,
  populate,
  populationOracles,
  type BlobPopulationReport,
  type ContentParsing,
  type ContributorTiming,
  type PopulateOptions,
  type PopulationCache,
} from './projection/merge.js';

// The one line a user sees when the blob stage declined to derive something.
// `populate()` computes the refusal counts on every run; until this shipped,
// every production caller threw them away, so a corpus in which every document
// was declined as binary produced an empty `blobs` table and exit 0. The counts
// are the half that `blob_conditions` cannot carry — nobody queries a projection
// they were never told to look at, and a skipped heading or reference is an
// absent row.
export { describeBlobRefusals } from './projection/blob-refusals.js';

// The declarative closure primitive (zones §7.3): a closure-defined extent is a
// GENERIC contributor handed an `ExtentDeclaration`, never new privileged code —
// which is what makes "a built-in must be expressible the way a config-declared
// one would be" satisfiable alongside the declarative-only rule. Identity (`id`,
// `kind`) comes from the constructor because the registry partitions on it before
// `contribute` runs; extent SHAPE arrives through `parameters`, so
// `zone_provenance.parameterSet` records what actually shaped the extent.
export {
  CLOSURE_CONTRIBUTOR_ID_PREFIX,
  CLOSURE_DEPTH_EXCEEDED,
  CLOSURE_REFERENCE_OUTSIDE_ROOT,
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
  ClosureExtentContributor,
} from './projection/contributors/closure-extent.js';
export {
  ExtentDeclarationSchema,
  ExtentRefusalRuleSchema,
  ExtentsConfigSchema,
  ReferenceDialectSchema,
  type ExtentDeclaration,
  type ExtentRefusalRule,
  type ExtentsConfig,
  type ReferenceDialect,
} from './schemas/project-config.js';
// How a declaration's `referenceDialect` is actually applied. Exported beside
// the schema because a consumer that declares `claude-import` and then resolves
// a token itself must reach the same reading the closure uses — a second
// interpretation of the same field is the drift the declared dialect exists to
// prevent.
export { resolveDialectRef } from './projection/contributors/reference-dialect.js';

// The blob-derivation stage the merge driver runs between the base and closure
// strata: the step that turns the base's `contentKey` columns into the four
// blob-keyed tables. Not a contributor — it declares no extent — but without it
// `blob_references` is empty, every closure extent is its declared root and
// nothing else, and the run reports success. Every keyed blob is derived,
// including the non-markdown ones, because the raw-source reference lexer is
// what lets a skill's `.mjs` scripts be closure members at all.
export {
  BLOB_CONTENT_CHANGED,
  BLOB_NOT_TEXT,
  BLOB_PARSE_FAILED,
  BLOB_UNREADABLE,
  populateBlobs,
  type BlobPopulationOptions,
  type BlobPopulationResult,
} from './projection/blob-population.js';

// Emitting the projection as a document — "no engine" (zones §15 step 6). Rows
// out; no index, no join, no filter, no query. Two properties are load-bearing:
// `roots.path` is the only absolute path in the model and is replaced with
// ROOT_PATH_PLACEHOLDER (VAT has already shipped evidence leaking $HOME), and
// every table is sorted by its primary key — one of `crawlDirectory`'s two
// routes enumerates in FILESYSTEM order, so an export carrying insertion order
// would make any golden differ between ext4, APFS and NTFS. Key order within a
// row is imposed here too, out of the table registry, so a projection a
// population derived and the same projection read back out of a store are the
// same bytes rather than the same values in whatever order each built them.
export {
  ROOT_PATH_PLACEHOLDER,
  UnregisteredProjectionColumnError,
  exportProjection,
  serializeProjection,
  type ProjectionDocument,
} from './projection/export.js';

