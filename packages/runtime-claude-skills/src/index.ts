/**
 * @vibe-agent-toolkit/runtime-claude-skills
 * Build and package VAT agents as Claude Skills
 */

export { buildClaudeSkill, type BuildOptions, type BuildResult } from './builder.js';

export {
  ClaudeSkillFrontmatterSchema,
  VATClaudeSkillFrontmatterSchema,
  type ClaudeSkillFrontmatter,
  type VATClaudeSkillFrontmatter,
} from './schemas/claude-skill-frontmatter.js';

export { PluginJsonSchema, PluginSchema, type Plugin } from './schemas/plugin.js';

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
export { detectResourceFormat } from './validators/format-detection.js';
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
