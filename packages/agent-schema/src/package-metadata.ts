/**
 * Package metadata schemas for VAT distribution standard
 *
 * Defines the `vat` field structure in package.json for distributing
 * VAT artifacts (skills, agents, pure functions, runtimes).
 */

import { z } from 'zod';

/**
 * Validation override value
 *
 * Supports both simple string format and extended object format with expiration.
 */
export const ValidationOverrideSchema = z.union([
  z.string().min(1).describe('Simple override reason'),
  z.object({
    reason: z.string().min(1).describe('Override reason'),
    expires: z.string().datetime().optional().describe('Optional expiration date (ISO 8601)'),
  }).describe('Extended override with optional expiration'),
]).describe('Validation override (reason or reason + expiration)');

export type ValidationOverride = z.infer<typeof ValidationOverrideSchema>;

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
  excludeReferencesFromBundle: z.object({
    rules: z.array(z.object({
      patterns: z.array(z.string())
        .describe('Glob patterns matched against path relative to skill root'),
      template: z.string()
        .optional()
        .describe(
          'Handlebars template for rewriting links to matched files.\n' +
          'Context: {{link.text}}, {{link.uri}}, {{link.fileName}}, {{link.filePath}}, {{skill.name}}\n' +
          'Default: "{{link.text}}"'
        ),
    })).optional().default([])
      .describe('Ordered rules evaluated first-match. Each rule matches file paths and specifies a rewrite template.'),
    defaultTemplate: z.string()
      .optional()
      .describe(
        'Handlebars template for non-bundled links that don\'t match any rule (depth-exceeded links).\n' +
        'Context: {{link.text}}, {{link.uri}}, {{link.fileName}}, {{link.filePath}}, {{skill.name}}\n' +
        'Default: "{{link.text}}"'
      ),
  }).optional(),
}).describe('Packaging options for skill distribution');

export type PackagingOptions = z.infer<typeof PackagingOptionsSchema>;

/**
 * Skill metadata for distribution
 *
 * Describes a Claude Skill packaged in this npm package.
 */
export const VatSkillMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Skill name (used for installation directory)'),
    source: z
      .string()
      .min(1)
      .describe('Source SKILL.md path (relative to package root, for rebuilding)'),
    path: z
      .string()
      .min(1)
      .describe('Built skill directory path (relative to package root)'),
    ignoreValidationErrors: z
      .record(z.string(), ValidationOverrideSchema)
      .optional()
      .describe('Validation errors to ignore (rule code -> override reason/config)'),
    packagingOptions: PackagingOptionsSchema
      .optional()
      .describe('Packaging configuration options'),
  })
  .describe('Claude Skill metadata for distribution');

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
    type: z
      .enum(['agent-bundle', 'skill', 'runtime', 'toolkit'])
      .describe('Package type'),
    skills: z
      .array(VatSkillMetadataSchema)
      .optional()
      .describe('Claude Skills for distribution'),
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
