/**
 * Validation rules for Claude Code skills
 *
 * Thresholds and their provenance — do not read this list as "Anthropic says so".
 * Only the first is Anthropic's; the rest are VAT's, and two of them Anthropic
 * actively contradicts. The full audit is in the comment above
 * VALIDATION_THRESHOLDS below; read it before tuning any number here.
 *
 * - SKILL.md recommended: ≤500 lines  (Anthropic's, verbatim)
 * - Total skill size: ≤2000 lines     (VAT's; Anthropic counter-signals it)
 * - File count: ≤6 files              (VAT's; Anthropic counter-signals it)
 * - Reference depth: ≤2 levels        (VAT's; Anthropic's rule is ONE level)
 *
 * References:
 * - https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 * - docs/external/anthropic-skill-authoring-best-practices.md (dated cache of the above)
 * - https://github.com/anthropics/skills (official examples)
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';

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
  | 'BROKEN_INTERNAL_LINK'
  | 'CIRCULAR_REFERENCE'
  | 'OUTSIDE_PROJECT_BOUNDARY'
  | 'WINDOWS_BACKSLASH_IN_PATH'
  | 'LINK_TARGETS_DIRECTORY'
  // Best practice rules (overridable)
  | 'SKILL_LENGTH_EXCEEDS_RECOMMENDED'
  | 'SKILL_TOTAL_SIZE_LARGE'
  | 'SKILL_TOO_MANY_FILES'
  | 'REFERENCE_TOO_DEEP'
  | 'LINKS_TO_NAVIGATION_FILES'
  | 'DESCRIPTION_TOO_VAGUE'
  | 'NO_PROGRESSIVE_DISCLOSURE'
  | 'PACKAGED_UNREFERENCED_FILE'
  | 'PACKAGED_TEST_INPUT'
  | 'PACKAGED_BROKEN_LINK';

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
 * Validation rule definitions
 */
export const VALIDATION_RULES: Record<ValidationRuleCode, ValidationRule> = {
  // Required rules (non-overridable)
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
  OUTSIDE_PROJECT_BOUNDARY: {
    code: 'OUTSIDE_PROJECT_BOUNDARY',
    category: 'required',
    message: (ctx) => `Link points outside project: ${(ctx['href'] as string) ?? 'unknown'}`,
    fix: 'Keep skills self-contained - move referenced files into the project',
  },
  // FILENAME_COLLISION is deliberately absent: it lives in CODE_REGISTRY and is
  // emitted by the packager (see `filenameCollisionIssue` in skill-packager.ts).
  // The entry that used to sit here was never emitted by anything and its fix
  // hint named `packagingOptions.usePathNames`, an option that does not exist —
  // a second, stale definition of one code is worse than none.
  WINDOWS_BACKSLASH_IN_PATH: {
    code: 'WINDOWS_BACKSLASH_IN_PATH',
    category: 'required',
    message: () => 'Path uses Windows backslashes',
    fix: 'Use forward slashes for cross-platform compatibility',
  },
  LINK_TARGETS_DIRECTORY: {
    code: 'LINK_TARGETS_DIRECTORY',
    category: 'required',
    message: (ctx) => `files: source '${(ctx['source'] as string) ?? 'unknown'}' resolves to a directory; a typed single-file slot requires a file`,
    fix: 'Point the files: source (or other single-file reference) at a specific file, not a directory.',
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
    example: 'api-reference, ui-components as separate skills',
  },
  SKILL_TOO_MANY_FILES: {
    code: 'SKILL_TOO_MANY_FILES',
    category: 'best_practice',
    message: (ctx) => `Skill includes ${Number(ctx['fileCount'] ?? 0)} files (recommended ≤6)`,
    fix: 'Split into focused sub-skills or use progressive disclosure',
    // This used to read "Official skills use 1-5 files", which is false: Anthropic's
    // own pdf/ example in the best-practices doc ships 7 (SKILL.md, FORMS.md,
    // reference.md, examples.md + 3 scripts). 6 is a VAT maintainability heuristic,
    // not a vendor limit — and Anthropic explicitly says to "Bundle comprehensive
    // resources … no context penalty until accessed".
    example: 'VAT heuristic, not an Anthropic limit — Anthropic\'s own pdf/ example ships 7 files',
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
  PACKAGED_UNREFERENCED_FILE: {
    code: 'PACKAGED_UNREFERENCED_FILE',
    category: 'best_practice',
    message: (ctx) => `Packaged file not referenced from any markdown: ${(ctx['relativePath'] as string) ?? 'unknown'}`,
    // Kept in step with CODE_REGISTRY's remedy: a file consumed programmatically is
    // declared in `files:` (a declared dest is exempt), NOT waived — a waiver list
    // that restates the `files:` map is the symptom this text used to cause.
    fix: 'Add a markdown link from SKILL.md or a linked resource, or declare it under skills.config.<name>.files as a source/dest pair',
  },
  PACKAGED_TEST_INPUT: {
    code: 'PACKAGED_TEST_INPUT',
    category: 'best_practice',
    message: (ctx) => `Declared test input packaged into the shipped skill: ${(ctx['relativePath'] as string) ?? 'unknown'}`,
    fix: 'Remove the files: entry mapping the eval suite into the bundle — test input is read from source, never shipped',
  },
  PACKAGED_BROKEN_LINK: {
    code: 'PACKAGED_BROKEN_LINK',
    category: 'best_practice',
    message: (ctx) => `Broken link in packaged output: ${(ctx['href'] as string) ?? 'unknown'} (from ${(ctx['mdPath'] as string) ?? 'unknown'})`,
    fix: 'Indicates a link-rewriting bug — the source link was valid but the packaged link is broken',
  },
};

/**
 * Validation thresholds — mostly VAT's, not Anthropic's (see the audit below)
 *
 * @vendor-claim reviewed=2026-07-30 verify=Re-fetch https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices and diff it against docs/external/anthropic-skill-authoring-best-practices.md
 *
 * The original header ("based on Anthropic guidance") overstated the provenance.
 * Of the six numbers here, the repo's own cached copy of Anthropic's guidance
 * supports only RECOMMENDED_SKILL_LINES (500), and it explicitly *disclaims*
 * MAX_DESCRIPTION_CHARS_CLAUDE_CODE (250) — Anthropic documents a 1024-character
 * maximum, while 250 is VAT's own reading of where the Claude Code `/skills`
 * listing truncates. MAX_TOTAL_LINES, MAX_FILE_COUNT, MAX_REFERENCE_DEPTH and
 * MIN_DESCRIPTION_LENGTH are VAT-originated.
 *
 * Re-verified against the live page on 2026-07-30. That pass sharpened two of
 * those verdicts from "unsupported" to "contradicted", which is a stronger claim:
 *
 * - MAX_REFERENCE_DEPTH (2) is CONTRADICTED, not merely VAT-originated. Anthropic:
 *   "Keep references one level deep from SKILL.md", and their "Bad example: Too
 *   deep" is literally `SKILL.md → advanced.md → details.md` — the exact chain
 *   REFERENCE_TOO_DEEP's own `example` string above blesses as "2 hops, OK". VAT
 *   is deliberately one hop laxer than the vendor here; that is a product
 *   decision, not an oversight, but nothing in this file may imply Anthropic
 *   endorses 2.
 * - MAX_TOTAL_LINES (2000) and MAX_FILE_COUNT (6) are COUNTER-SIGNALLED, not just
 *   silent. Anthropic's runtime-environment guidance says "Bundle comprehensive
 *   resources: Include complete API docs, extensive examples, large datasets; no
 *   context penalty until accessed", and "No context penalty for large files".
 *   Their own pdf/ example ships 7 files, one past MAX_FILE_COUNT. VAT flags large
 *   bundles as a maintainability/reviewability signal, which the vendor does not.
 * - MIN_DESCRIPTION_LENGTH (50) stays SILENT-not-contradicted: Anthropic rejects
 *   vague descriptions ("Helps with documents") on specificity, never on length.
 *
 * The `reviewed=` date above is now a real review date, not the cache's Fetched
 * date. Do not resolve any of these divergences by editing a number here — the
 * values decide what fires on adopter trees and are the repo owner's call.
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

  /**
   * Claude Code /skills listing truncates descriptions at this character count (since v2.1.86).
   * Descriptions longer than this lose their tail — critical trigger keywords may be cut.
   */
  MAX_DESCRIPTION_CHARS_CLAUDE_CODE: 250,
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
