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

export {
  parseFrontmatter,
  type FrontmatterResult,
} from './parsers/frontmatter-parser.js';

export { validateSkill } from './validators/skill-validator.js';
export type { ValidationResult, ValidationIssue, ValidateOptions } from './validators/types.js';
