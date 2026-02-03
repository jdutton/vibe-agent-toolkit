import { z } from 'zod';

/**
 * Claude Skill Frontmatter Schema (Strict)
 *
 * Based on official Agent Skills specification at agentskills.io/specification
 * Console-compatible: Only allows fields defined in the spec
 */
export const ClaudeSkillFrontmatterSchema = z.object({
  // Required fields
  name: z.string()
    .min(1, 'Name is required')
    .max(64, 'Name must be 64 characters or less')
    .regex(
      // eslint-disable-next-line security/detect-unsafe-regex -- simple pattern for skill names, max length enforced
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Name must be lowercase alphanumeric with hyphens, no consecutive hyphens, cannot start/end with hyphen'
    )
    .describe('Skill identifier, must match parent directory name'),

  description: z.string()
    .min(1, 'Description is required')
    .max(1024, 'Description must be 1024 characters or less')
    .describe('What the skill does and when to use it'),

  // Optional fields (from spec)
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

  'allowed-tools': z.string()
    .optional()
    .describe('Pre-approved tools (experimental)'),
}).strict(); // Reject unknown fields for console compatibility

export type ClaudeSkillFrontmatter = z.infer<typeof ClaudeSkillFrontmatterSchema>;

/**
 * VAT Claude Skill Frontmatter Schema
 *
 * Extends strict schema with VAT-specific metadata requirements
 * Used when building/validating VAT-generated skills
 */
export const VATClaudeSkillFrontmatterSchema = ClaudeSkillFrontmatterSchema.extend({
  metadata: z.object({
    version: z.string()
      .describe('Semantic version of this skill'),
  }).passthrough(), // Allow additional metadata fields
});

export type VATClaudeSkillFrontmatter = z.infer<typeof VATClaudeSkillFrontmatterSchema>;
