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

// Projection schema v2 — the zones revision (docs/architecture/zones.md).
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
  RealizationConditionRowSchema,
  ResourceExtentRowSchema,
  ResourceKindSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
  ResourceTagRowSchema,
  ResourceTagSourceSchema,
  RootRowSchema,
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
