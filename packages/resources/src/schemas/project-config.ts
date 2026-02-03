import { z } from 'zod';

/**
 * Validation mode for frontmatter schema validation.
 *
 * - `strict`: Enforce schema exactly (respect additionalProperties: false)
 * - `permissive`: Allow extra fields (ignore additionalProperties: false)
 */
export const ValidationModeSchema = z.enum(['strict', 'permissive'])
  .describe('Validation mode for frontmatter schema validation');

export type ValidationMode = z.infer<typeof ValidationModeSchema>;

/**
 * Validation configuration for a collection.
 */
export const CollectionValidationSchema = z.object({
  frontmatterSchema: z.string().optional()
    .describe('Path to JSON Schema file for frontmatter validation (relative to config file or package reference like @vibe-agent-toolkit/schemas/skill.v1.json)'),
  mode: ValidationModeSchema.optional()
    .describe('Validation mode (default: strict)'),
  checkUrlLinks: z.boolean().optional()
    .describe('Whether to validate external URL links (default: false)'),
  checkGitIgnored: z.boolean().optional()
    .describe('Whether to check if non-ignored files link to git-ignored files (default: true)'),
}).describe('Validation configuration for a collection');

export type CollectionValidation = z.infer<typeof CollectionValidationSchema>;

/**
 * Configuration for a named collection of resources.
 *
 * Collections define include/exclude patterns and validation rules.
 * A file can belong to multiple collections.
 */
export const CollectionConfigSchema = z.object({
  include: z.array(z.string()).min(1)
    .describe('Include patterns (paths or globs like docs/**/*.md)'),
  exclude: z.array(z.string()).optional()
    .describe('Exclude patterns (globs)'),
  validation: CollectionValidationSchema.optional()
    .describe('Validation configuration for this collection'),
}).describe('Configuration for a named collection of resources');

export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;

/**
 * Resources section of project configuration.
 */
export const ResourcesConfigSchema = z.object({
  include: z.array(z.string()).optional()
    .describe('Global default include patterns (not used by collections in Phase 2)'),
  exclude: z.array(z.string()).optional()
    .describe('Global default exclude patterns (not used by collections in Phase 2)'),
  collections: z.record(z.string(), CollectionConfigSchema)
    .describe('Named collections of resources'),
}).describe('Resources section of project configuration');

export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;

/**
 * Complete project configuration schema.
 */
export const ProjectConfigSchema = z.object({
  version: z.literal(1)
    .describe('Config file version (must be 1)'),
  resources: ResourcesConfigSchema.optional()
    .describe('Resources configuration'),
}).describe('vibe-agent-toolkit project configuration');

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
