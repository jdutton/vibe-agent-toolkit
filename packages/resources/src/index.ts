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

// Export main ResourceRegistry class
export {
  ResourceRegistry,
  type CrawlOptions,
  type ResourceRegistryOptions,
  type RegistryStats,
} from './resource-registry.js';

// Export ResourceQuery for lazy evaluation and filtering
export { ResourceQuery } from './resource-query.js';

// Export ResourceCollection for immutable collections with lazy duplicate detection
export { ResourceCollection } from './resource-collection.js';

// Export ResourceCollectionInterface for collection behavior
export type { ResourceCollectionInterface } from './resource-collection-interface.js';

// Export all type definitions (from schemas)
export type {
  LinkType,
  HeadingNode,
  ResourceLink,
  ResourceMetadata,
  ValidationSeverity,
  ValidationIssue,
  ValidationResult,
  ProjectConfig,
  ResourcesConfig,
  CollectionConfig,
  CollectionValidation,
  ValidationMode,
} from './types.js';

// Export schemas for external use (e.g., JSON Schema generation, runtime validation)
export {
  LinkTypeSchema,
  HeadingNodeSchema,
  ResourceLinkSchema,
  ResourceMetadataSchema,
} from './schemas/resource-metadata.js';

export {
  ValidationSeveritySchema,
  ValidationIssueSchema,
  ValidationResultSchema,
} from './schemas/validation-result.js';

// Export parser interface for advanced use cases
export { parseMarkdown, type ParseResult } from './link-parser.js';

// Export frontmatter validation
export { validateFrontmatter } from './frontmatter-validator.js';

// Note: link-parser and link-validator internals are NOT exported
// They are implementation details. Users should use ResourceRegistry API.
