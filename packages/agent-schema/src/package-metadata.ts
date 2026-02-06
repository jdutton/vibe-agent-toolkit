/**
 * Package metadata schemas for VAT distribution standard
 *
 * Defines the `vat` field structure in package.json for distributing
 * VAT artifacts (skills, agents, pure functions, runtimes).
 */

import { z } from 'zod';

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
