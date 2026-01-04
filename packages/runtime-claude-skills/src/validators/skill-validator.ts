import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * @param options - Validation options
 * @returns Validation result with issues
 */
export async function validateSkill(options: ValidateOptions): Promise<ValidationResult> {
  const { skillPath, rootDir = path.dirname(skillPath), isVATGenerated = false } = options;

  const issues: ValidationIssue[] = [];

  // Read file
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

  // Validate schema
  validateFrontmatterSchema(frontmatter, isVATGenerated, issues);

  // Additional validation rules
  validateAdditionalRules(frontmatter, issues);

  // Extract and validate links
  validateLinks(content, skillPath, rootDir, issues);

  // Check warning-level rules
  validateWarningRules(content, lineCount, skillPath, issues);

  // Build metadata object
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

function validateLinks(
  content: string,
  skillPath: string,
  rootDir: string,
  issues: ValidationIssue[]
): void {
  const links = extractLinksFromContent(content);

  for (const link of links) {
    validateSingleLink(link, skillPath, rootDir, issues);
  }
}

function extractLinksFromContent(content: string): Array<{ text: string; path: string; line: number }> {
  // Extract markdown links
  // eslint-disable-next-line sonarjs/slow-regex -- regex is bounded by line length (max ~1000 chars per line in markdown)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links: Array<{ text: string; path: string; line: number }> = [];

  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line) continue;

    let match;
    while ((match = linkRegex.exec(line)) !== null) {
      const linkPath = match[2];
      if (linkPath) {
        links.push({
          text: match[1] ?? '',
          path: linkPath,
          line: i + 1,
        });
      }
    }
  }

  return links;
}

function validateSingleLink(
  link: { text: string; path: string; line: number },
  skillPath: string,
  rootDir: string,
  issues: ValidationIssue[]
): void {
  // Skip external and anchor links
  if (link.path.startsWith('http://') || link.path.startsWith('https://') || link.path.startsWith('#')) {
    return;
  }

  // Check for Windows-style backslashes
  if (link.path.includes('\\')) {
    issues.push({
      severity: 'error',
      code: 'PATH_STYLE_WINDOWS',
      message: `Link uses Windows-style backslashes: ${link.path}`,
      location: `${skillPath}:${link.line}`,
      fix: 'Change backslashes to forward slashes',
    });
    return;
  }

  // Resolve and check if file exists
  const resolvedPath = link.path.startsWith('/')
    ? path.join(rootDir, link.path)
    : path.resolve(path.dirname(skillPath), link.path);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedPath is constructed from validated inputs
  if (!fs.existsSync(resolvedPath)) {
    issues.push({
      severity: 'error',
      code: 'LINK_INTEGRITY_BROKEN',
      message: `Link target does not exist: ${link.path}`,
      location: `${skillPath}:${link.line}`,
      fix: 'Create file or fix link path',
    });
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
  // Tools that require file system access or modification
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
      // Only report once per skill
      break;
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

  // Determine status based on issue severity
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

  // Only add metadata if it's provided (for exactOptionalPropertyTypes compatibility)
  if (metadata) {
    result.metadata = metadata;
  }

  return result;
}
