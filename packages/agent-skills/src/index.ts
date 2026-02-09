/**
 * @vibe-agent-toolkit/agent-skills
 * Build, validate, and package agent skills in the Agent Skills format
 */

export { buildClaudeSkill, type BuildOptions, type BuildResult } from './builder.js';

export {
  extractH1Title,
  packageSkill,
  type PackageSkillOptions,
  type PackageSkillResult,
  type SkillMetadata,
} from './skill-packager.js';

export {
  ClaudeSkillFrontmatterSchema,
  VATClaudeSkillFrontmatterSchema,
  type ClaudeSkillFrontmatter,
  type VATClaudeSkillFrontmatter,
} from './schemas/claude-skill-frontmatter.js';

export { ClaudePluginJsonSchema, ClaudePluginSchema, type ClaudePlugin } from './schemas/claude-plugin.js';

export {
  MarketplaceJsonSchema,
  MarketplaceSchema,
  type LspServerConfig,
  type Marketplace,
  type MarketplacePlugin,
  type PluginSource,
} from './schemas/marketplace.js';

export {
  parseFrontmatter,
  type FrontmatterResult,
} from './parsers/frontmatter-parser.js';

export { validateSkill } from './validators/skill-validator.js';
export { validate } from './validators/unified-validator.js';
export { detectResourceFormat } from './validators/format-detection.js';
export {
  validateSkillForPackaging,
  type PackagingValidationResult,
} from './validators/packaging-validator.js';
export {
  createIssue,
  isOverridable,
  NAVIGATION_FILE_PATTERNS,
  NON_OVERRIDABLE_RULES,
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
  type RuleCategory,
  type ValidationRule,
  type ValidationRuleCode,
} from './validators/validation-rules.js';
export type {
  ValidationResult,
  ValidationIssue,
  ValidateOptions,
  ResourceFormat,
} from './validators/types.js';

export {
  importSkillToAgent,
  type ImportOptions,
  type ImportResult,
} from './import.js';

export {
  collectLinks,
  type DefaultRule,
  type ExcludeRule,
  type LinkCollectionOptions,
  type LinkCollectionResult,
  type LinkResolution,
} from './link-collector.js';

// Re-export ValidationOverride from agent-schema for convenience
export type { ValidationOverride } from '@vibe-agent-toolkit/agent-schema';
