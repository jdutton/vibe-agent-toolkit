/**
 * Package metadata schemas for VAT distribution standard
 *
 * Defines the `vat` field structure in package.json for distributing
 * VAT artifacts (skills, agents, pure functions, runtimes).
 */

import { z } from 'zod';

/**
 * Skill name pattern: kebab-case segments, optionally colon-namespaced as {plugin}:{skill}.
 *
 * Examples: "my-skill", "vibe-agent-toolkit:resources"
 *
 * The colon namespace is intentional design — it is the `{plugin-name}:{sub-skill}` separator
 * used both in SKILL.md frontmatter and in vat.skills[].name in package.json.
 *
 * Important: colons are sanitized to "__" when used as filesystem paths (Windows-safe).
 * Do not use the name directly as a directory name — use a sanitization helper.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- simple pattern for skill names, max length enforced externally
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$/;
export const SKILL_NAME_REGEX_MESSAGE =
  'Skill name must be lowercase kebab-case, optionally namespaced as {plugin}:{skill} ' +
  '(e.g. "my-skill" or "vibe-agent-toolkit:resources")';

/**
 * Packaging options for skill distribution
 *
 * Controls how skills are packaged and distributed.
 */
export const PackagingOptionsSchema = z.object({
  resourceNaming: z
    .enum(['basename', 'resource-id', 'preserve-path'])
    .optional()
    .describe(
      'Strategy for naming packaged resource files:\n' +
      '  - basename: Use original filename only (default, may conflict)\n' +
      '  - resource-id: Flatten path to kebab-case filename (e.g., topics-quickstart-overview.md)\n' +
      '  - preserve-path: Preserve directory structure (e.g., topics/quickstart/overview.md)'
    ),
  stripPrefix: z
    .string()
    .optional()
    .describe('Path prefix to strip before applying naming strategy (e.g., "knowledge-base")'),
  linkFollowDepth: z
    .union([z.number().int().min(0), z.literal('full')])
    .optional()
    .describe(
      'How deep to follow markdown links from SKILL.md for bundling:\n' +
      '  0 = skill file only (no link following)\n' +
      '  1 = direct links only\n' +
      '  2 = direct + one transitive level (default, recommended)\n' +
      '  N = N levels of transitive links\n' +
      '  "full" = complete transitive closure (use with caution)'
    ),
  excludeNavigationFiles: z
    .boolean()
    .optional()
    .describe(
      'Whether to exclude navigation files (README.md, index.md, etc.) from bundle.\n' +
      'Default: true (matches Anthropic best practices)'
    ),
  excludeReferencesFromBundle: z.object({
    rules: z.array(z.object({
      patterns: z.array(z.string())
        .describe('Glob patterns matched against path relative to skill root'),
      template: z.string()
        .optional()
        .describe(
          'Handlebars template for rewriting links to matched files.\n' +
          'Context: {{link.text}}, {{link.href}}, {{link.fragment}}, {{link.type}}, {{link.resource.id}}, {{link.resource.fileName}}, {{link.resource.relativePath}}, {{skill.name}}\n' +
          'Default: "{{link.text}}"'
        ),
    })).optional().default([])
      .describe('Ordered rules evaluated first-match. Each rule matches file paths and specifies a rewrite template.'),
    defaultTemplate: z.string()
      .optional()
      .describe(
        'Handlebars template for non-bundled links that don\'t match any rule (depth-exceeded links).\n' +
        'Context: {{link.text}}, {{link.href}}, {{link.fragment}}, {{link.type}}, {{link.resource.id}}, {{link.resource.fileName}}, {{link.resource.relativePath}}, {{skill.name}}\n' +
        'Default: "{{link.text}}"'
      ),
  }).optional(),
}).describe('Packaging options for skill distribution');

export type PackagingOptions = z.infer<typeof PackagingOptionsSchema>;

/**
 * Skill name for distribution.
 *
 * In package.json vat.skills, each entry is just the skill name string.
 * All packaging configuration now lives in vibe-agent-toolkit.config.yaml.
 */
export const VatSkillMetadataSchema = z
  .string()
  .min(1)
  .max(64, 'Name must be 64 characters or less')
  .regex(SKILL_NAME_REGEX, SKILL_NAME_REGEX_MESSAGE)
  .describe('Skill name for distribution (must match a discovered skill in config yaml)');

export type VatSkillMetadata = z.infer<typeof VatSkillMetadataSchema>;

/**
 * Agent metadata for distribution
 *
 * Describes a VAT agent (agent.yaml based) packaged in this npm package.
 */
export const VatAgentMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Agent name'),
    path: z
      .string()
      .min(1)
      .describe('Agent directory path (relative to package root)'),
    type: z
      .string()
      .optional()
      .describe('Agent archetype (optional, e.g., "llm-analyzer", "pure-function")'),
  })
  .describe('VAT agent metadata for distribution');

export type VatAgentMetadata = z.infer<typeof VatAgentMetadataSchema>;

/**
 * Pure function tool metadata for distribution
 *
 * Describes a pure function tool exposed via MCP/CLI.
 */
export const VatPureFunctionMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Pure function name'),
    path: z
      .string()
      .min(1)
      .describe('Implementation path (relative to package root)'),
    exports: z
      .object({
        mcp: z
          .string()
          .optional()
          .describe('MCP server export path (relative to package root)'),
        cli: z
          .string()
          .optional()
          .describe('CLI invocation pattern (e.g., "vat-cat-agents haiku-validate")'),
      })
      .optional()
      .describe('Export mechanisms for this pure function'),
  })
  .describe('Pure function tool metadata for distribution');

export type VatPureFunctionMetadata = z.infer<typeof VatPureFunctionMetadataSchema>;

/**
 * VAT package metadata (package.json "vat" field)
 *
 * Complete metadata for a VAT package that can contain skills, agents,
 * pure functions, and runtime adapters.
 */
export const VatPackageMetadataSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+$/)
      .describe('VAT metadata schema version (currently "1.0")'),
    // DEPRECATED(v0.1.x): vat.type is a single choice for the whole package which
    // is meaningless — a package can contain skills AND agents AND pure functions.
    // Tolerated in schema for backward compat with existing package.json files.
    // NO CODE should read, branch on, or generate this field.
    // Remove entirely after v1.0
    type: z
      .enum(['agent-bundle', 'skill', 'runtime', 'toolkit'])
      .optional()
      .describe('DEPRECATED: Do not use. Will be removed in v1.0. A package can contain multiple artifact types.'),
    skills: z
      .array(VatSkillMetadataSchema)
      .optional()
      .describe('Skill names for npm discoverability'),
    agents: z
      .array(VatAgentMetadataSchema)
      .optional()
      .describe('VAT agents (agent.yaml based)'),
    pureFunctions: z
      .array(VatPureFunctionMetadataSchema)
      .optional()
      .describe('Pure function tools'),
    runtimes: z
      .array(z.string())
      .optional()
      .describe('Runtime adapters provided (e.g., "vercel-ai-sdk", "langchain")'),
  })
  .describe('VAT package metadata (package.json "vat" field)');

export type VatPackageMetadata = z.infer<typeof VatPackageMetadataSchema>;
