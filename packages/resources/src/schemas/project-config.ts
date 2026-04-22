import { ValidationConfigSchema } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

// Re-export for downstream consumers (unicorn/prefer-export-from satisfied by the import above)
export { ValidationConfigSchema } from '@vibe-agent-toolkit/agent-schema';

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
  collections: z.record(z.string(), CollectionConfigSchema).optional()
    .describe('Named collections of resources'),
}).describe('Resources section of project configuration');

export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;

// ---------------------------------------------------------------------------
// Skill packaging configuration (self-contained — no agent-schema dependency)
// ---------------------------------------------------------------------------

/**
 * A rule for excluding references from a skill bundle.
 */
export const ExcludeReferenceRuleSchema = z.object({
  patterns: z.array(z.string()).describe('Glob patterns matched against path relative to skill root'),
  template: z.string().optional().describe('Handlebars template for rewriting links to matched files'),
});

/**
 * Configuration for excluding references from a skill bundle.
 */
export const ExcludeReferencesFromBundleSchema = z.object({
  rules: z.array(ExcludeReferenceRuleSchema).optional().default([]),
  defaultTemplate: z.string().optional().describe('Handlebars template for non-bundled links that don\'t match any rule'),
});

/**
 * A file entry mapping a source path to a destination path in the skill output.
 *
 * Used for build artifacts, unlinked files, and routing overrides.
 * - source: path relative to project root (where vibe-agent-toolkit.config.yaml lives)
 * - dest: path relative to the skill's output directory (sibling to SKILL.md)
 */
export const SkillFileEntrySchema = z.object({
  source: z.string().min(1).describe('Source path relative to project root'),
  dest: z.string().min(1).describe('Destination path relative to skill output directory'),
});

export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

/**
 * Skill packaging configuration.
 *
 * Controls how a skill is bundled: link-follow depth, resource naming,
 * reference exclusion rules, and validation overrides.
 */
export const SkillPackagingConfigSchema = z.object({
  publish: z.boolean().optional()
    .describe('Whether this skill is published for distribution (default: true). Set to false for in-development skills.'),
  linkFollowDepth: z.union([z.number().int().min(0), z.literal('full')]).optional(),
  resourceNaming: z.enum(['basename', 'resource-id', 'preserve-path']).optional(),
  stripPrefix: z.string().optional(),
  excludeNavigationFiles: z.boolean().optional(),
  excludeReferencesFromBundle: ExcludeReferencesFromBundleSchema.optional(),
  validation: ValidationConfigSchema.optional()
    .describe('Validation framework config: severity overrides and per-path allow entries'),
  targets: z.array(z.enum(['claude-chat', 'claude-cowork', 'claude-code'])).optional()
    .describe('Declared runtime targets for this skill. Suppresses non-applicable compat verdicts.'),
  files: z.array(SkillFileEntrySchema).optional().describe('Explicit source→dest file mappings for build artifacts, unlinked files, or routing overrides'),
}).strict().describe('Skill packaging configuration');

export type SkillPackagingConfig = z.infer<typeof SkillPackagingConfigSchema>;

/**
 * Skills discovery and packaging configuration.
 *
 * Defines how to find SKILL.md files and how to package them.
 */
export const SkillsConfigSchema = z.object({
  include: z.array(z.string()).min(1).describe('Glob patterns to find SKILL.md files (e.g., "skills/**/SKILL.md")'),
  exclude: z.array(z.string()).optional().describe('Glob patterns to exclude'),
  defaults: SkillPackagingConfigSchema.optional().describe('Default packaging config for all skills'),
  config: z.record(z.string(), SkillPackagingConfigSchema).optional().describe('Per-skill packaging config overrides (keyed by skill name)'),
}).strict().describe('Skills discovery and packaging configuration');

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

// ---------------------------------------------------------------------------
// Claude marketplace configuration
// ---------------------------------------------------------------------------

/**
 * A plugin entry within a Claude marketplace configuration.
 *
 * Supports full Claude plugin bundling:
 * - `skills` (optional): pool-skill selector (name list or "*"). Absent/[] = no pool skills.
 * - `source` (optional): path to plugin dir (default: plugins/<name>). Tree-copied verbatim.
 * - `files` (optional): explicit source->dest mappings for artifacts built outside the plugin dir.
 */
export const ClaudeMarketplacePluginEntrySchema = z.object({
  name: z.string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Plugin name must be lowercase alphanumeric with hyphens (regex: ^[a-z0-9][a-z0-9-]*$)')
    .describe('Plugin name (lowercase alphanumeric with hyphens)'),
  description: z.string().optional()
    .describe('Plugin description'),
  skills: z.union([z.literal('*'), z.array(z.string())]).optional()
    .transform((val) => (Array.isArray(val) && val.length === 0 ? undefined : val))
    .describe('Pool skills to include: "*" for all, or array of skill name selectors. Omit for no pool skills (plugin-local skills still ship).'),
  source: z.string().optional()
    .describe('Path to plugin directory (default: plugins/<name>)'),
  files: z.array(SkillFileEntrySchema).optional()
    .describe('Explicit source→dest file mappings for compiled artifacts outside the plugin directory'),
}).strict().describe('Plugin entry within a marketplace configuration');

export type ClaudeMarketplacePluginEntry = z.infer<typeof ClaudeMarketplacePluginEntrySchema>;

/**
 * Publish configuration for a Claude marketplace.
 * Controls where and how the marketplace is published to a Git branch or repo.
 */
export const ClaudeMarketplacePublishSchema = z.object({
  branch: z.string().optional()
    .describe('Target branch name (default: claude-marketplace)'),
  remote: z.string().optional()
    .describe('Git remote name (e.g., "origin") or full URL (e.g., "https://github.com/org/marketplace-repo.git") for cross-repo publishing (default: origin)'),
  changelog: z.string().optional()
    .describe('Path to marketplace changelog (Keep a Changelog format; used during both build and publish, overriding project root CHANGELOG.md)'),
  readme: z.string().optional()
    .describe('Path to marketplace README (used during both build and publish, overriding project root README.md)'),
  license: z.string().optional()
    .describe('SPDX license identifier (e.g., "mit") or file path (e.g., "./LICENSE")'),
  sourceRepo: z.union([z.boolean(), z.string()]).optional()
    .describe('Source repo URL for commit metadata (false to disable, string to override)'),
}).strict().describe('Publish configuration for marketplace distribution');

export type ClaudeMarketplacePublish = z.infer<typeof ClaudeMarketplacePublishSchema>;

/**
 * Configuration for a single Claude marketplace.
 */
export const ClaudeMarketplaceSchema = z.object({
  owner: z.object({
    name: z.string(),
    email: z.string().optional(),
  }).strict().describe('Marketplace owner information'),

  skills: z.union([z.literal('*'), z.array(z.string())]).optional()
    .describe('Default skill filter for the marketplace — restricts which skills are available when plugins use skills: "*". Omit to allow all skills. This does NOT add skills directly; skills are always selected per-plugin.'),

  publish: ClaudeMarketplacePublishSchema.optional()
    .describe('Publish configuration for marketplace distribution'),

  plugins: z.array(ClaudeMarketplacePluginEntrySchema).min(1)
    .describe('Plugin groupings within this marketplace'),
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
  skills: SkillsConfigSchema.optional()
    .describe('Skills discovery and packaging configuration'),
  resources: ResourcesConfigSchema.optional()
    .describe('Resources configuration'),
  claude: ClaudeConfigSchema.optional()
    .describe('Claude-specific configuration (marketplaces, managed-settings)'),
}).strict().describe('vibe-agent-toolkit project configuration');

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
