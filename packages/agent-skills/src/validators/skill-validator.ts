import * as fs from 'node:fs';

import { parseFrontmatter } from '../parsers/frontmatter-parser.js';
import { ClaudeSkillFrontmatterSchema, VATClaudeSkillFrontmatterSchema } from '../schemas/claude-skill-frontmatter.js';

import type { ValidateOptions, ValidationIssue, ValidationResult } from './types.js';

// Location constants for validation messages
const FRONTMATTER_LOC = 'frontmatter';
const FRONTMATTER_NAME_LOC = 'frontmatter.name';
const FRONTMATTER_DESC_LOC = 'frontmatter.description';

/**
 * Validate a Claude Skill (SKILL.md file)
 *
 * Uses ResourceRegistry for markdown/link validation
 * Adds skill-specific validation (frontmatter schema, skill rules)
 *
 * @param options - Validation options
 * @returns Validation result with all validation issues
 */
export async function validateSkill(options: ValidateOptions): Promise<ValidationResult> {
  const { skillPath, isVATGenerated = false } = options;

  const issues: ValidationIssue[] = [];

  // Validate file exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillPath is user-provided but validated
  if (!fs.existsSync(skillPath)) {
    return {
      path: skillPath,
      type: isVATGenerated ? 'vat-agent' : 'claude-skill',
      status: 'error',
      summary: '1 error',
      issues: [{
        severity: 'error',
        code: 'SKILL_MISSING_FRONTMATTER',
        message: 'File does not exist',
        location: skillPath,
      }],
    };
  }

  // Read file
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillPath validated above
  const content = fs.readFileSync(skillPath, 'utf-8');
  const lineCount = content.split('\n').length;

  // Parse frontmatter
  const parseResult = parseFrontmatter(content);

  if (!parseResult.success) {
    issues.push({
      severity: 'error',
      code: 'SKILL_MISSING_FRONTMATTER',
      message: parseResult.error,
      location: `${skillPath}:1`,
      fix: 'Add YAML frontmatter with name and description fields',
    });

    return buildResult(skillPath, isVATGenerated, issues, { lineCount });
  }

  const { frontmatter } = parseResult;

  // Validate frontmatter schema (skill-specific)
  validateFrontmatterSchema(frontmatter, isVATGenerated, issues);

  // Validate additional skill rules (skill-specific)
  validateAdditionalRules(frontmatter, issues);

  // Validate warning-level rules (skill-specific)
  validateWarningRules(content, lineCount, skillPath, issues);

  // NOTE: Link validation is handled by resource validation (vat resources validate)
  // We don't duplicate that logic here. Trust that SKILL.md is validated as a markdown resource.

  // Build metadata
  const metadata = buildMetadata(frontmatter, lineCount);

  return buildResult(skillPath, isVATGenerated, issues, metadata);
}

function validateFrontmatterSchema(
  frontmatter: Record<string, unknown>,
  isVATGenerated: boolean,
  issues: ValidationIssue[]
): void {
  const schema = isVATGenerated ? VATClaudeSkillFrontmatterSchema : ClaudeSkillFrontmatterSchema;
  const schemaResult = schema.safeParse(frontmatter);

  if (schemaResult.success) {
    return;
  }

  // Map Zod errors to our issue codes
  for (const error of schemaResult.error.errors) {
    const field = error.path.join('.');

    if (field === 'name' && !frontmatter['name']) {
      issues.push({
        severity: 'error',
        code: 'SKILL_MISSING_NAME',
        message: 'Required field "name" is missing',
        location: FRONTMATTER_LOC,
        fix: 'Add "name" field to frontmatter',
      });
    } else if (field === 'description' && !frontmatter['description']) {
      issues.push({
        severity: 'error',
        code: 'SKILL_MISSING_DESCRIPTION',
        message: 'Required field "description" is missing',
        location: FRONTMATTER_LOC,
        fix: 'Add "description" field to frontmatter',
      });
    } else if (field === 'name') {
      issues.push({
        severity: 'error',
        code: 'SKILL_NAME_INVALID',
        message: error.message,
        location: FRONTMATTER_NAME_LOC,
        fix: 'Change name to lowercase alphanumeric with hyphens (e.g., "my-skill")',
      });
    } else if (field === 'description' && error.message.includes('1024')) {
      issues.push({
        severity: 'error',
        code: 'SKILL_DESCRIPTION_TOO_LONG',
        message: `Description exceeds 1024 characters (actual: ${(frontmatter['description'] as string)?.length ?? 0})`,
        location: FRONTMATTER_DESC_LOC,
        fix: 'Reduce description to 1024 characters or less',
      });
    }
  }
}

function validateAdditionalRules(
  frontmatter: Record<string, unknown>,
  issues: ValidationIssue[]
): void {
  // Validate name field
  if (frontmatter['name'] && typeof frontmatter['name'] === 'string') {
    const name = frontmatter['name'].toLowerCase();

    // Check for reserved words
    if (name.includes('anthropic') || name.includes('claude')) {
      issues.push({
        severity: 'error',
        code: 'SKILL_NAME_RESERVED_WORD',
        message: 'Name contains reserved word "anthropic" or "claude"',
        location: FRONTMATTER_NAME_LOC,
        fix: 'Remove reserved word from name',
      });
    }

    // Check for XML tags
    if (/[<>]/.test(frontmatter['name'])) {
      issues.push({
        severity: 'error',
        code: 'SKILL_NAME_XML_TAGS',
        message: 'Name contains XML tags',
        location: FRONTMATTER_NAME_LOC,
        fix: 'Remove < and > characters from name',
      });
    }
  }

  // Validate description field
  if (frontmatter['description'] && typeof frontmatter['description'] === 'string') {
    // Check for XML tags
    if (/[<>]/.test(frontmatter['description'])) {
      issues.push({
        severity: 'error',
        code: 'SKILL_DESCRIPTION_XML_TAGS',
        message: 'Description contains XML tags',
        location: FRONTMATTER_DESC_LOC,
        fix: 'Remove < and > characters from description',
      });
    }

    // Check for empty description
    if (frontmatter['description'].trim() === '') {
      issues.push({
        severity: 'error',
        code: 'SKILL_DESCRIPTION_EMPTY',
        message: 'Description is empty',
        location: FRONTMATTER_DESC_LOC,
        fix: 'Add description explaining what the skill does and when to use it',
      });
    }
  }
}

function validateWarningRules(
  content: string,
  lineCount: number,
  skillPath: string,
  issues: ValidationIssue[]
): void {
  // Check if skill is too long (>5000 lines)
  const MAX_SKILL_LINES = 5000;
  if (lineCount > MAX_SKILL_LINES) {
    issues.push({
      severity: 'warning',
      code: 'SKILL_TOO_LONG',
      message: `Skill exceeds recommended length (${lineCount} > ${MAX_SKILL_LINES} lines)`,
      location: skillPath,
      fix: 'Consider breaking skill into multiple smaller skills or using reference files',
    });
  }

  // Check for console-incompatible features
  const toolPatterns = [
    { tool: 'Write', pattern: /\bWrite\s+tool\b/i },
    { tool: 'Edit', pattern: /\bEdit\s+tool\b/i },
    { tool: 'Bash', pattern: /\bBash\s+tool\b/i },
    { tool: 'NotebookEdit', pattern: /\bNotebookEdit\s+tool\b/i },
  ];

  for (const { tool, pattern } of toolPatterns) {
    if (pattern.test(content)) {
      issues.push({
        severity: 'warning',
        code: 'SKILL_CONSOLE_INCOMPATIBLE',
        message: `Skill references "${tool}" tool which is not available in console mode`,
        location: skillPath,
        fix: 'Add note that skill requires IDE/CLI mode, or make skill console-compatible',
      });
      break; // Only report once
    }
  }
}

function buildMetadata(
  frontmatter: Record<string, unknown>,
  lineCount: number
): ValidationResult['metadata'] {
  const metadata: ValidationResult['metadata'] = { lineCount };

  if (frontmatter['name'] && typeof frontmatter['name'] === 'string') {
    metadata.name = frontmatter['name'];
  }

  if (frontmatter['description'] && typeof frontmatter['description'] === 'string') {
    metadata.description = frontmatter['description'];
  }

  return metadata;
}

function buildResult(
  skillPath: string,
  isVATGenerated: boolean,
  issues: ValidationIssue[],
  metadata?: ValidationResult['metadata']
): ValidationResult {
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;

  let status: ValidationResult['status'];
  if (errorCount > 0) {
    status = 'error';
  } else if (warningCount > 0) {
    status = 'warning';
  } else {
    status = 'success';
  }

  const summary = `${errorCount} errors, ${warningCount} warnings, ${infoCount} info`;

  const result: ValidationResult = {
    path: skillPath,
    type: isVATGenerated ? 'vat-agent' : 'claude-skill',
    status,
    summary,
    issues,
  };

  if (metadata) {
    result.metadata = metadata;
  }

  return result;
}
