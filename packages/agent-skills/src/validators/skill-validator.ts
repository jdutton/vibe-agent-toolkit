import * as fs from 'node:fs';

import { parseFrontmatter } from '../parsers/frontmatter-parser.js';

import { validateFrontmatterRules, validateFrontmatterSchema } from './frontmatter-validation.js';
import type { ValidateOptions, ValidationIssue, ValidationResult } from './types.js';

/**
 * Validate an Agent Skill (SKILL.md file)
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
      type: isVATGenerated ? 'vat-agent' : 'agent-skill',
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

  // Validate frontmatter schema (shared with packaging validator)
  issues.push(
    ...validateFrontmatterSchema(frontmatter, isVATGenerated),
    ...validateFrontmatterRules(frontmatter),
  );

  // Validate warning-level rules (skill-specific)
  validateWarningRules(content, lineCount, skillPath, issues);

  // NOTE: Link validation is handled by resource validation (vat resources validate)
  // We don't duplicate that logic here. Trust that SKILL.md is validated as a markdown resource.

  // Build metadata
  const metadata = buildMetadata(frontmatter, lineCount);

  return buildResult(skillPath, isVATGenerated, issues, metadata);
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
    type: isVATGenerated ? 'vat-agent' : 'agent-skill',
    status,
    summary,
    issues,
  };

  if (metadata) {
    result.metadata = metadata;
  }

  return result;
}
