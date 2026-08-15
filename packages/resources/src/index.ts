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
  PROJECTION_SCHEMA_VERSION,
  ProjectionConditionSeveritySchema,
  type JsonValue,
  type ProjectionConditionSeverity,
} from './schemas/projection-shared.js';

export {
  BlobConditionRowSchema,
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
export {
  collectRealization,
  realPathOrNull,
  relativize,
  type ContentDemand,
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
export {
  ProjectionBuilder,
  REALIZATION_PATH_COLLISION,
  type Projection,
  type ProjectionBase,
} from './projection/projection.js';

// Lexical reference extraction: reference candidates the markdown AST cannot
// see (@-prefixed tokens, variable-anchored paths, bounded bare tokens).
export {
  collectCodeContextRanges,
  detectVariableExpansion,
  findLexicalReferences,
  type CodeContextRanges,
  type LexicalReference,
  type OffsetRange,
} from './reference-lexer.js';

// Export parser interface for advanced use cases
export { parseMarkdown, classifyLink, isLocalFileLink, type ParseResult } from './link-parser.js';

// Parse identity: which parser a path routes to, and the key a parse result is
// filed under. Path-independent by construction — see content-key.ts.
export {
  computeContentKey,
  parserKindForPath,
  readContentWithKey,
  type KeyedContent,
  type ParserKind,
} from './content-key.js';

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
export {
  ParseCache,
  defaultParseCache,
  parseCacheDirectory,
  parseFileCached,
  parseKeyed,
  vatCacheNamespace,
  vatCacheNamespaceRoot,
  vatCacheRoot,
  type ParseCacheOptions,
  type ParseCacheStats,
} from './parse-cache.js';

export { parseHtml } from './html-link-parser.js';
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

export { ContentCache, type ContentMetadata } from './content-cache.js';

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

// Blob-keyed reference rows — the markdown AST's links and the raw-source
// lexer's tokens unified into one position-ordered ordinal space.
export { blobReferencesFor } from './projection/blob-references.js';

// The filesystem extent (zones §2): everything on disk under the root, files
// AND directories, excluding NEVER_CRAWL_GLOBS but deliberately NOT build
// output — this is the extent that sees what the git extent cannot.
export { FilesystemExtentContributor } from './projection/contributors/filesystem-extent.js';

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
  ClosureNonConvergenceError,
  populate,
  type BlobPopulationReport,
  type ContributorTiming,
  type PopulateOptions,
} from './projection/merge.js';

// The declarative closure primitive (zones §7.3): a closure-defined extent is a
// GENERIC contributor handed an `ExtentDeclaration`, never new privileged code —
// which is what makes "a built-in must be expressible the way a config-declared
// one would be" satisfiable alongside the declarative-only rule. Identity (`id`,
// `kind`) comes from the constructor because the registry partitions on it before
// `contribute` runs; extent SHAPE arrives through `parameters`, so
// `zone_provenance.parameterSet` records what actually shaped the extent.
export {
  CLOSURE_CONTRIBUTOR_ID_PREFIX,
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
  ClosureExtentContributor,
} from './projection/contributors/closure-extent.js';
export {
  ExtentDeclarationSchema,
  ExtentRefusalRuleSchema,
  ExtentsConfigSchema,
  type ExtentDeclaration,
  type ExtentRefusalRule,
  type ExtentsConfig,
} from './schemas/project-config.js';

// The blob-derivation stage the merge driver runs between the base and closure
// strata: the step that turns the base's `contentKey` columns into the four
// blob-keyed tables. Not a contributor — it declares no extent — but without it
// `blob_references` is empty, every closure extent is its declared root and
// nothing else, and the run reports success. Every keyed blob is derived,
// including the non-markdown ones, because the raw-source reference lexer is
// what lets a skill's `.mjs` scripts be closure members at all.
export {
  BLOB_CONTENT_CHANGED,
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
// would make any golden differ between ext4, APFS and NTFS.
export {
  ROOT_PATH_PLACEHOLDER,
  exportProjection,
  serializeProjection,
  type ProjectionDocument,
} from './projection/export.js';

// The crawl-timing seam: which contributor, stratum and fixpoint pass owns the
// time it takes to FIND documents, as against `parse-timing.ts`'s account of the
// time it takes to parse them. Exported from the barrel — unlike `parse-timing`,
// which stays package-internal — because one of the two crawlers it measures
// (`walkLinkGraph`) lives in `agent-skills`, and both arms must record through
// ONE recorder or the two are not comparable.
export {
  CRAWL_CLOSURE_CONTRIBUTE_ID,
  CRAWL_CLOSURE_RESOLVE_ID,
  CRAWL_PASS_INSIDE,
  CRAWL_STRATA,
  CRAWL_WALKER_GITIGNORE_ID,
  CRAWL_WALKER_ID,
  crawlTimingStart,
  recordContributorInvocation,
  recordCrawlPass,
  type CrawlStratum,
  type CrawlTimingDump,
  type CrawlTimingEntry,
  type CrawlTimingProcess,
  __readCrawlTimingSnapshot,
  __setCrawlTimingForTest,
  __writeCrawlTimingDumpForTest,
} from './crawl-timing.js';
