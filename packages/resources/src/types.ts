/**
 * Type definitions for the resources package.
 *
 * This module re-exports all types from the Zod schemas for convenient imports.
 * All types are automatically inferred from their corresponding Zod schemas,
 * ensuring TypeScript types and runtime validation remain synchronized.
 *
 * @example
 * ```typescript
 * import type { ResourceMetadata, ValidationResult } from '@vibe-agent-toolkit/resources';
 * ```
 */

// Checksum types
export type { SHA256 } from './schemas/checksum.js';
export { SHA256Schema } from './schemas/checksum.js';

// Resource metadata types
export type {
  LinkType,
  HeadingNode,
  ResourceLink,
  ResourceMetadata,
} from './schemas/resource-metadata.js';

// Validation result types
export type {
  ValidationSeverity,
  ValidationIssue,
  ValidationResult,
} from './schemas/validation-result.js';

// Resource registry types
export type {
  CrawlOptions,
  ResourceRegistryOptions,
  ValidateOptions,
  RegistryStats,
} from './resource-registry.js';

// Resource type system
export {
  ResourceType,
  isJsonSchema,
} from './types/resources.js';
export type {
  BaseResource,
  Heading,
  JsonResource,
  JsonSchemaResource,
  MarkdownResource,
  Resource,
  YamlResource,
} from './types/resources.js';

// Resource path utilities
export {
  getResourceAbsolutePath,
  isValidProjectPath,
  normalizeProjectPath,
} from './types/resource-path-utils.js';

// Resource parsing
export {
  detectResourceType,
  parseJsonResource,
  parseJsonSchemaResource,
  parseMarkdownResource,
  parseYamlResource,
} from './types/resource-parser.js';

// Project configuration
export type {
  ValidationMode,
  CollectionValidation,
  CollectionConfig,
  ResourcesConfig,
  ProjectConfig,
} from './schemas/project-config.js';

// Config parsing
export {
  findConfigFile,
  parseConfigFile,
  loadConfig,
} from './config-parser.js';

// Pattern expansion
export {
  isGlobPattern,
  expandPattern,
  expandPatterns,
} from './pattern-expander.js';

// Collection matching
export {
  matchesCollection,
  getCollectionsForFile,
} from './collection-matcher.js';

// Link validation
export type { ValidateLinkOptions } from './link-validator.js';
export { validateLink } from './link-validator.js';
