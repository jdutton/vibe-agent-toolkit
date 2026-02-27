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
 * External URL validation configuration.
 *
 * Controls how external URLs are validated:
 * - enabled: Whether to check external URLs
 * - timeout: Request timeout in milliseconds (default: 15000)
 * - retryOn429: Whether to retry on rate limit (default: true)
 * - ignorePatterns: Regex patterns for URLs to skip (e.g., '^https://localhost')
 */
export const ExternalUrlValidationSchema = z.object({
  enabled: z.boolean().optional()
    .describe('Whether to validate external URLs (default: false)'),
  timeout: z.number().int().positive().optional()
    .describe('Request timeout in milliseconds (default: 15000)'),
  retryOn429: z.boolean().optional()
    .describe('Whether to retry on rate limit (429) (default: true)'),
  ignorePatterns: z.array(z.string()).optional()
    .describe('Regex patterns for URLs to skip validation (e.g., "^https://localhost")'),
}).describe('External URL validation configuration');

export type ExternalUrlValidation = z.infer<typeof ExternalUrlValidationSchema>;

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
  externalUrls: ExternalUrlValidationSchema.optional()
    .describe('External URL validation configuration'),
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
 * Output paths for a Claude marketplace.
 */
export const ClaudeMarketplaceOutputSchema = z.object({
  marketplaceJson: z.string().optional()
    .describe('Output path for marketplace.json (default: dist/.claude-plugin/marketplace.json)'),
  pluginsDir: z.string().optional()
    .describe('Output directory for plugin artifacts (default: dist/plugins/)'),
}).strict().optional()
  .describe('Output paths for generated marketplace artifacts');

export type ClaudeMarketplaceOutput = z.infer<typeof ClaudeMarketplaceOutputSchema>;

/**
 * A plugin entry within a Claude marketplace configuration.
 */
export const ClaudeMarketplacePluginEntrySchema = z.object({
  name: z.string()
    .describe('Plugin name (lowercase alphanumeric with hyphens)'),
  skills: z.union([z.literal('*'), z.array(z.string())]).optional()
    .describe('Skills to include: "*" for all, or array of skill name selectors'),
  version: z.string().optional()
    .describe('Plugin version (default: from package.json)'),
  license: z.string().optional()
    .describe('License identifier (e.g., MIT)'),
}).strict().describe('Plugin entry within a marketplace configuration');

export type ClaudeMarketplacePluginEntry = z.infer<typeof ClaudeMarketplacePluginEntrySchema>;

/**
 * Configuration for a single Claude marketplace.
 *
 * Supports two variants:
 * - Source-layout: `file:` points to existing marketplace.json — VAT verifies but does not generate
 * - Inline: owner/skills/plugins define what to build — VAT generates the artifacts
 */
export const ClaudeMarketplaceSchema = z.object({
  // Source-layout pattern: point to existing file for verify-only
  file: z.string().optional()
    .describe('Path to existing marketplace.json (source-layout — VAT verifies only, does not generate)'),

  // Inline definition (used when VAT generates the marketplace artifacts)
  owner: z.object({
    name: z.string(),
    email: z.string().optional(),
  }).strict().optional()
    .describe('Marketplace owner information'),

  metadata: z.object({
    description: z.string().optional(),
    version: z.string().optional(),
  }).strict().optional()
    .describe('Marketplace metadata'),

  skills: z.array(z.string()).optional()
    .describe('Skill name selectors (exact names or glob patterns matching vat.skills names)'),

  plugins: z.array(ClaudeMarketplacePluginEntrySchema).optional()
    .describe('Plugin groupings within this marketplace'),

  output: ClaudeMarketplaceOutputSchema,
}).strict().describe('Configuration for a Claude plugin marketplace');

export type ClaudeMarketplaceConfig = z.infer<typeof ClaudeMarketplaceSchema>;

/**
 * Claude-specific section of project configuration.
 */
export const ClaudeConfigSchema = z.object({
  managedSettings: z.string().optional()
    .describe('Path to managed-settings.json for schema validation (relative to config file)'),
  marketplaces: z.record(z.string(), ClaudeMarketplaceSchema).optional()
    .describe('Named map of Claude plugin marketplaces (never singleton)'),
}).strict().describe('Claude-specific project configuration');

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

/**
 * Complete project configuration schema.
 */
export const ProjectConfigSchema = z.object({
  version: z.literal(1)
    .describe('Config file version (must be 1)'),
  resources: ResourcesConfigSchema.optional()
    .describe('Resources configuration'),
  claude: ClaudeConfigSchema.optional()
    .describe('Claude-specific configuration (marketplaces, managed-settings)'),
}).describe('vibe-agent-toolkit project configuration');

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
