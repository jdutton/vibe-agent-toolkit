/**
 * Validation rules for Claude Code skills
 *
 * Based on Anthropic's official guidance and research findings:
 * - SKILL.md recommended: ≤500 lines
 * - Total skill size: ≤2000 lines
 * - File count: ≤6 files
 * - Reference depth: ≤2 levels
 *
 * References:
 * - https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 * - https://github.com/anthropics/skills (official examples)
 */

import type { ValidationIssue } from './types.js';

/**
 * Validation rule category
 * - required: Non-overridable rules (fundamental correctness)
 * - best_practice: Overridable rules (Anthropic recommendations)
 */
export type RuleCategory = 'required' | 'best_practice';

/**
 * Validation rule code
 */
export type ValidationRuleCode =
  // Required rules (non-overridable)
  | 'INVALID_FRONTMATTER'
  | 'MISSING_NAME'
  | 'RESERVED_WORD_IN_NAME'
  | 'BROKEN_INTERNAL_LINK'
  | 'CIRCULAR_REFERENCE'
  | 'OUTSIDE_PACKAGE_BOUNDARY'
  | 'FILENAME_COLLISION'
  | 'WINDOWS_BACKSLASH_IN_PATH'
  | 'LINK_TARGETS_DIRECTORY'
  // Best practice rules (overridable)
  | 'SKILL_LENGTH_EXCEEDS_RECOMMENDED'
  | 'SKILL_TOTAL_SIZE_LARGE'
  | 'SKILL_TOO_MANY_FILES'
  | 'REFERENCE_TOO_DEEP'
  | 'LINKS_TO_NAVIGATION_FILES'
  | 'DESCRIPTION_TOO_VAGUE'
  | 'NO_PROGRESSIVE_DISCLOSURE';

/**
 * Validation rule definition
 */
export interface ValidationRule {
  code: ValidationRuleCode;
  category: RuleCategory;
  message: (context: Record<string, unknown>) => string;
  fix: string;
  example?: string;
  link?: string;
}

/**
 * Non-overridable validation rules
 * These enforce fundamental correctness and cannot be ignored
 */
export const NON_OVERRIDABLE_RULES: ValidationRuleCode[] = [
  'INVALID_FRONTMATTER',
  'MISSING_NAME',
  'RESERVED_WORD_IN_NAME',
  'BROKEN_INTERNAL_LINK',
  'CIRCULAR_REFERENCE',
  'OUTSIDE_PACKAGE_BOUNDARY',
  'FILENAME_COLLISION',
  'WINDOWS_BACKSLASH_IN_PATH',
  'LINK_TARGETS_DIRECTORY',
];

/**
 * Validation rule definitions
 */
export const VALIDATION_RULES: Record<ValidationRuleCode, ValidationRule> = {
  // Required rules (non-overridable)
  INVALID_FRONTMATTER: {
    code: 'INVALID_FRONTMATTER',
    category: 'required',
    message: () => 'YAML frontmatter syntax error',
    fix: 'Fix YAML syntax in frontmatter',
  },
  MISSING_NAME: {
    code: 'MISSING_NAME',
    category: 'required',
    message: () => 'Skill must have a name (frontmatter, H1, or filename)',
    fix: 'Add name to frontmatter: name: my-skill',
  },
  RESERVED_WORD_IN_NAME: {
    code: 'RESERVED_WORD_IN_NAME',
    category: 'required',
    message: () => 'Skill name contains reserved word (anthropic/claude)',
    fix: 'Choose a different name',
  },
  BROKEN_INTERNAL_LINK: {
    code: 'BROKEN_INTERNAL_LINK',
    category: 'required',
    message: (ctx) => `Link target not found: ${(ctx['href'] as string) ?? 'unknown'}`,
    fix: 'Fix link path or restore missing file',
  },
  CIRCULAR_REFERENCE: {
    code: 'CIRCULAR_REFERENCE',
    category: 'required',
    message: (ctx) => `Circular reference detected: ${(ctx['chain'] as string) ?? 'unknown'}`,
    fix: 'Remove circular link dependency',
  },
  OUTSIDE_PACKAGE_BOUNDARY: {
    code: 'OUTSIDE_PACKAGE_BOUNDARY',
    category: 'required',
    message: (ctx) => `Link points outside skill package: ${(ctx['href'] as string) ?? 'unknown'}`,
    fix: 'Keep skills self-contained - move referenced files into package',
  },
  FILENAME_COLLISION: {
    code: 'FILENAME_COLLISION',
    category: 'required',
    message: (ctx) => `Multiple files have same basename: ${(ctx['filename'] as string) ?? 'unknown'}`,
    fix: 'Enable path-based naming: packagingOptions.usePathNames: true',
  },
  WINDOWS_BACKSLASH_IN_PATH: {
    code: 'WINDOWS_BACKSLASH_IN_PATH',
    category: 'required',
    message: () => 'Path uses Windows backslashes',
    fix: 'Use forward slashes for cross-platform compatibility',
  },
  LINK_TARGETS_DIRECTORY: {
    code: 'LINK_TARGETS_DIRECTORY',
    category: 'required',
    message: (ctx) => `Link targets directory "${(ctx['dirPath'] as string) ?? 'unknown'}". Link to a specific file instead (e.g., "${(ctx['dirPath'] as string) ?? 'unknown'}/README.md" or "${(ctx['dirPath'] as string) ?? 'unknown'}/index.md").`,
    fix: 'Link to a specific file instead of a directory',
  },

  // Best practice rules (overridable)
  SKILL_LENGTH_EXCEEDS_RECOMMENDED: {
    code: 'SKILL_LENGTH_EXCEEDS_RECOMMENDED',
    category: 'best_practice',
    message: (ctx) => `SKILL.md is ${Number(ctx['lines'] ?? 0)} lines (recommended ≤500)`,
    fix: 'Use progressive disclosure - move detailed content to reference files',
    example: 'See pdf skill: SKILL.md (314 lines) + forms.md + reference.md',
    link: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
  },
  SKILL_TOTAL_SIZE_LARGE: {
    code: 'SKILL_TOTAL_SIZE_LARGE',
    category: 'best_practice',
    message: (ctx) => `Total skill size is ${Number(ctx['totalLines'] ?? 0)} lines (recommended ≤2000)`,
    fix: 'Split into multiple focused skills by domain',
    example: 'manuscript-data-models, manuscript-forms as separate skills',
  },
  SKILL_TOO_MANY_FILES: {
    code: 'SKILL_TOO_MANY_FILES',
    category: 'best_practice',
    message: (ctx) => `Skill includes ${Number(ctx['fileCount'] ?? 0)} files (recommended ≤6)`,
    fix: 'Split into focused sub-skills or use progressive disclosure',
    example: 'Official skills use 1-5 files',
  },
  REFERENCE_TOO_DEEP: {
    code: 'REFERENCE_TOO_DEEP',
    category: 'best_practice',
    message: (ctx) =>
      `Link chain is ${Number(ctx['depth'] ?? 0)} hops deep (recommended ≤2). Each linked file's own links create additional hops.`,
    fix: 'Reduce transitive link chains by moving deep content to RAG search or using linkFollowDepth configuration',
    example: 'SKILL.md → reference.md (1 hop), SKILL.md → advanced.md → details.md (2 hops, OK)',
  },
  LINKS_TO_NAVIGATION_FILES: {
    code: 'LINKS_TO_NAVIGATION_FILES',
    category: 'best_practice',
    message: (ctx) => `Links to navigation files: ${(ctx['files'] as string) ?? 'unknown'}`,
    fix: 'Link directly to specific topic documents instead of navigation indexes',
    example: '[Operators](patterns/calculations/operators.md) not [Overview](patterns/README.md)',
  },
  DESCRIPTION_TOO_VAGUE: {
    code: 'DESCRIPTION_TOO_VAGUE',
    category: 'best_practice',
    message: (ctx) => `Description is ${Number(ctx['length'] ?? 0)} characters (recommended ≥50)`,
    fix: 'Add descriptive summary (50+ chars) to frontmatter',
    example: 'description: "Extract text and tables from PDFs, fill forms, merge documents"',
  },
  NO_PROGRESSIVE_DISCLOSURE: {
    code: 'NO_PROGRESSIVE_DISCLOSURE',
    category: 'best_practice',
    message: (ctx) => `SKILL.md is ${Number(ctx['lines'] ?? 0)} lines with no reference files`,
    fix: 'Move detailed content to reference files (forms.md, reference.md)',
    example: 'Keep SKILL.md under 500 lines, link to detailed content',
  },
};

/**
 * Validation thresholds (based on Anthropic guidance)
 */
export const VALIDATION_THRESHOLDS = {
  /** Recommended maximum lines for SKILL.md */
  RECOMMENDED_SKILL_LINES: 500,

  /** Maximum total lines for entire skill (all files) */
  MAX_TOTAL_LINES: 2000,

  /** Maximum number of files in skill */
  MAX_FILE_COUNT: 6,

  /** Maximum reference depth (levels of nested links) */
  MAX_REFERENCE_DEPTH: 2,

  /** Minimum description length (characters) */
  MIN_DESCRIPTION_LENGTH: 50,
} as const;

/**
 * Navigation file patterns to detect
 */
export const NAVIGATION_FILE_PATTERNS = [
  'README.md',
  'readme.md',
  'index.md',
  'INDEX.md',
  'toc.md',
  'TOC.md',
  'overview.md',
  'OVERVIEW.md',
] as const;

/**
 * Check if an error code is overridable
 */
export function isOverridable(code: ValidationRuleCode): boolean {
  return !NON_OVERRIDABLE_RULES.includes(code);
}

/**
 * Create a validation issue from a rule
 */
export function createIssue(
  rule: ValidationRule,
  context: Record<string, unknown> = {},
  location?: string
): ValidationIssue {
  const issue: ValidationIssue = {
    severity: 'error',
    code: rule.code as never, // Cast to satisfy existing IssueCode type
    message: rule.message(context),
    fix: rule.fix,
  };

  if (location) {
    issue.location = location;
  }

  return issue;
}
