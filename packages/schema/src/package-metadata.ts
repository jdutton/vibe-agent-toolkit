/**
 * Package metadata schemas for VAT distribution standard
 *
 * Defines the `vat` field structure in package.json for distributing
 * VAT skills and plugins.
 */

import { z } from 'zod';

/**
 * Skill name pattern: kebab-case segments, optionally colon-namespaced as {plugin}:{skill}.
 *
 * Examples: "my-skill", "vibe-agent-toolkit:vat-audit"
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
  '(e.g. "my-skill" or "vibe-agent-toolkit:vat-audit")';

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
 * VAT package metadata (package.json "vat" field)
 *
 * Complete metadata for a VAT package that distributes skills.
 */
export const VatPackageMetadataSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+$/)
      .describe('VAT metadata schema version (currently "1.0")'),
    // DEPRECATED(v0.1.x): vat.type is a single choice for the whole package which
    // is meaningless — a package can contain more than one kind of artifact.
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
    replaces: z
      .object({
        plugins: z.array(z.string()).optional().describe('Old plugin names (without marketplace) this package used to publish under'),
        flatSkills: z.array(z.string()).optional().describe('Old skill names installed to ~/.claude/skills/<name> (the legacy flat location); each must be a single path segment'),
      })
      .strict()
      .optional()
      .describe('What `vat claude plugin install` removes before installing this package'),
  }).passthrough() /* adopter-authored package.json `vat` block: a key stripped until now must not become a refusal */
  .describe('VAT package metadata (package.json "vat" field)');

export type VatPackageMetadata = z.infer<typeof VatPackageMetadataSchema>;
