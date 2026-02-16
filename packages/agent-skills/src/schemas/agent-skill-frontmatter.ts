import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Agent Skill Frontmatter Schema
 *
 * Accepts both agentskills.io specification fields and Claude Code skill fields.
 * Uses `.passthrough()` to allow unknown fields from future spec versions.
 *
 * @see https://agentskills.io/specification — portable skill spec
 * @see https://code.claude.com/docs/en/skills — Claude Code skill frontmatter
 */
export const AgentSkillFrontmatterSchema = z.object({
  // --- agentskills.io fields ---

  name: z.string()
    .min(1)
    .max(64, 'Name must be 64 characters or less')
    .regex(
      // eslint-disable-next-line security/detect-unsafe-regex -- simple pattern for skill names, max length enforced
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Name must be lowercase alphanumeric with hyphens, no consecutive hyphens, cannot start/end with hyphen'
    )
    .optional()
    .describe('Skill identifier — defaults to parent directory name if omitted'),

  description: z.string()
    .min(1)
    .max(1024, 'Description must be 1024 characters or less')
    .optional()
    .describe('What the skill does and when to use it'),

  license: z.string()
    .optional()
    .describe('License applied to this skill'),

  compatibility: z.string()
    .max(500, 'Compatibility must be 500 characters or less')
    .optional()
    .describe('Environment requirements (e.g., "Requires git, docker, jq")'),

  metadata: z.record(z.string())
    .optional()
    .describe('Additional properties not defined by the spec'),

  // --- Claude Code fields ---

  'allowed-tools': z.string()
    .optional()
    .describe('Space-separated list of pre-approved tools'),

  'argument-hint': z.string()
    .optional()
    .describe('Hint text shown to the user when invoking the skill'),

  'disable-model-invocation': z.boolean()
    .optional()
    .describe('Whether the model can invoke this skill automatically (default: false)'),

  'user-invocable': z.boolean()
    .optional()
    .describe('Whether the user can invoke this skill via slash command (default: true)'),

  model: z.string()
    .optional()
    .describe('Model to use when running this skill (e.g., "sonnet", "opus")'),

  context: z.string()
    .optional()
    .describe('Execution context (e.g., "fork" for isolated context)'),

  agent: z.string()
    .optional()
    .describe('Agent identity for multi-agent workflows'),

  hooks: z.record(z.unknown())
    .optional()
    .describe('Lifecycle hooks (e.g., PostToolUse)'),
}).passthrough(); // Accept unknown fields for forward compatibility

export type AgentSkillFrontmatter = z.infer<typeof AgentSkillFrontmatterSchema>;

/**
 * JSON Schema representation of AgentSkillFrontmatterSchema
 *
 * Useful for external tooling that consumes JSON Schema directly.
 */
export const AgentSkillFrontmatterJsonSchema = zodToJsonSchema(
  AgentSkillFrontmatterSchema,
  { name: 'AgentSkillFrontmatter', $refStrategy: 'none' },
);

/**
 * VAT Agent Skill Frontmatter Schema
 *
 * Extends the base schema with stricter requirements for VAT-packaged skills:
 * - `name` and `description` are required (not optional)
 * - `metadata.version` is required
 *
 * @see https://agentskills.io/specification — portable skill spec
 */
export const VATAgentSkillFrontmatterSchema = AgentSkillFrontmatterSchema.extend({
  name: z.string()
    .min(1, 'Name is required for VAT skills')
    .max(64, 'Name must be 64 characters or less')
    .regex(
      // eslint-disable-next-line security/detect-unsafe-regex -- simple pattern for skill names, max length enforced
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Name must be lowercase alphanumeric with hyphens, no consecutive hyphens, cannot start/end with hyphen'
    )
    .describe('Skill identifier (required for VAT skills)'),

  description: z.string()
    .min(1, 'Description is required for VAT skills')
    .max(1024, 'Description must be 1024 characters or less')
    .describe('What the skill does and when to use it'),

  metadata: z.object({
    version: z.string()
      .describe('Semantic version of this skill'),
  }).passthrough(), // Allow additional metadata fields
});

export type VATAgentSkillFrontmatter = z.infer<typeof VATAgentSkillFrontmatterSchema>;
