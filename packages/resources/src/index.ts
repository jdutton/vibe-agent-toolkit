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
  generateIdFromPath,
  type CrawlOptions,
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

// Export parser interface for advanced use cases
export { parseMarkdown, classifyLink, isLocalFileLink, type ParseResult } from './link-parser.js';

export { parseHtml } from './html-link-parser.js';
// HtmlParseError is Zod-sourced (single source of truth) — see schemas/resource-metadata.ts.
export type { HtmlParseError } from './schemas/resource-metadata.js';
export { rewriteHtmlLinks, type UnappliedRewrite } from './html-transform.js';

// Export frontmatter validation
export { validateFrontmatter } from './frontmatter-validator.js';

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
