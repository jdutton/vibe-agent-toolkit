import * as fs from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';

import { parseFrontmatter } from '../parsers/frontmatter-parser.js';

import { validateFrontmatterRules, validateFrontmatterSchema } from './frontmatter-validation.js';
import type { LinkedFileValidationResult, ValidateOptions, ValidationIssue, ValidationResult } from './types.js';
import { NAVIGATION_FILE_PATTERNS } from './validation-rules.js';

/**
 * Validate an Agent Skill (SKILL.md file)
 *
 * Uses ResourceRegistry for markdown/link validation
 * Adds skill-specific validation (frontmatter schema, skill rules)
 *
 * @see https://code.claude.com/docs/en/skills — Official Claude Code skill spec
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

  // Transitive link traversal (BFS)
  const skillDir = options.rootDir ?? dirname(skillPath);
  const linkedFiles = await traverseLinks(skillPath, skillDir, issues);

  // Unreferenced file detection
  if (options.checkUnreferencedFiles) {
    detectUnreferencedFiles(skillPath, skillDir, linkedFiles, issues);
  }

  // Build metadata
  const metadata = buildMetadata(frontmatter, lineCount);

  const result = buildResult(skillPath, isVATGenerated, issues, metadata);

  if (linkedFiles.length > 0) {
    result.linkedFiles = linkedFiles;
  }

  return result;
}


// ============================================================================
// Link Traversal (BFS)
// ============================================================================

/** Files to never flag as unreferenced */
const UNREFERENCED_EXCLUDE_PATTERNS = new Set([
  'SKILL.md',
  'CLAUDE.md',
  ...(NAVIGATION_FILE_PATTERNS as readonly string[]),
]);

/**
 * Validate a single local_file link: boundary check, existence check.
 *
 * @returns 'boundary' | 'broken' | 'valid' indicating the link status
 */
function validateLocalLink(
  link: { href: string; line?: number | undefined },
  currentPath: string,
  skillDir: string,
  fileIssues: ValidationIssue[],
  issues: ValidationIssue[],
): { status: 'skip' | 'boundary' | 'broken' | 'valid'; resolvedPath: string } {
  // Strip anchor fragment before resolving
  const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
  if (hrefWithoutAnchor === '') {
    return { status: 'skip', resolvedPath: '' };
  }

  const resolvedPath = resolve(dirname(currentPath), hrefWithoutAnchor);
  const relativeToBoundary = relative(skillDir, resolvedPath);

  // Check boundary escape
  if (relativeToBoundary.startsWith('..')) {
    const issue: ValidationIssue = {
      severity: 'warning',
      code: 'OUTSIDE_PROJECT_BOUNDARY',
      message: `Link points outside skill directory: ${link.href}`,
      location: `${currentPath}:${link.line ?? 0}`,
      fix: 'Keep skills self-contained — move referenced files into the skill directory',
    };
    fileIssues.push(issue);
    issues.push(issue);
    return { status: 'boundary', resolvedPath };
  }

  // Check existence
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedPath from parsed markdown
  if (!fs.existsSync(resolvedPath)) {
    const issue: ValidationIssue = {
      severity: 'error',
      code: 'LINK_INTEGRITY_BROKEN',
      message: `Link target not found: ${link.href}`,
      location: `${currentPath}:${link.line ?? 0}`,
      fix: 'Fix link path or restore missing file',
    };
    fileIssues.push(issue);
    issues.push(issue);
    return { status: 'broken', resolvedPath };
  }

  return { status: 'valid', resolvedPath };
}

/** Result of processing a single file's links */
interface FileProcessResult {
  localLinkCount: number;
  linksValidated: number;
  fileIssues: ValidationIssue[];
  newPaths: string[];
  content: string;
}

/**
 * Process all local links in a parsed markdown file.
 * Returns link validation results and newly discovered paths for BFS.
 */
function processFileLinks(
  parseResult: { links: Array<{ type: string; href: string; line?: number | undefined }>; content: string },
  currentPath: string,
  skillDir: string,
  issues: ValidationIssue[],
  visited: Set<string>,
): FileProcessResult {
  const localLinks = parseResult.links.filter(link => link.type === 'local_file');
  const fileIssues: ValidationIssue[] = [];
  const newPaths: string[] = [];
  let linksValidated = 0;

  for (const link of localLinks) {
    const { status, resolvedPath } = validateLocalLink(link, currentPath, skillDir, fileIssues, issues);

    if (status === 'skip') {
      continue;
    }

    linksValidated++;

    if (status === 'valid' && resolvedPath.endsWith('.md') && !visited.has(resolvedPath)) {
      visited.add(resolvedPath);
      newPaths.push(resolvedPath);
    }
  }

  return { localLinkCount: localLinks.length, linksValidated, fileIssues, newPaths, content: parseResult.content };
}

/**
 * Traverse links from SKILL.md using BFS, validating each link target.
 *
 * - Missing file -> LINK_INTEGRITY_BROKEN error
 * - Outside skill directory -> OUTSIDE_PROJECT_BOUNDARY warning
 * - Existing .md file -> recurse (add to BFS queue)
 * - Non-markdown asset -> existence check only
 */
async function traverseLinks(
  skillPath: string,
  skillDir: string,
  issues: ValidationIssue[],
): Promise<LinkedFileValidationResult[]> {
  const resolvedSkillPath = resolve(skillPath);
  const visited = new Set<string>([resolvedSkillPath]);
  const linkedFiles: LinkedFileValidationResult[] = [];
  const queue: string[] = [resolvedSkillPath];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath) {
      break;
    }

    let parseResult;
    try {
      parseResult = await parseMarkdown(currentPath);
    } catch {
      issues.push({
        severity: 'warning',
        code: 'LINK_INTEGRITY_BROKEN',
        message: `File exists but could not be parsed: ${currentPath}`,
        location: currentPath,
      });
      continue;
    }

    const processed = processFileLinks(parseResult, currentPath, skillDir, issues, visited);
    queue.push(...processed.newPaths);

    // Record linked file result (skip SKILL.md itself — it's the root)
    if (currentPath !== resolvedSkillPath) {
      linkedFiles.push({
        path: currentPath,
        lineCount: processed.content.split('\n').length,
        linksFound: processed.localLinkCount,
        linksValidated: processed.linksValidated,
        issues: processed.fileIssues,
      });
    }
  }

  return linkedFiles;
}

/**
 * Detect .md files in the skill directory that are not reachable from SKILL.md.
 *
 * Excludes SKILL.md, CLAUDE.md, and navigation file patterns (README.md, etc.).
 */
function detectUnreferencedFiles(
  skillPath: string,
  skillDir: string,
  linkedFiles: LinkedFileValidationResult[],
  issues: ValidationIssue[],
): void {
  // Collect all visited paths (SKILL.md + linked files)
  const visitedPaths = new Set<string>([resolve(skillPath)]);
  for (const lf of linkedFiles) {
    visitedPaths.add(lf.path);
  }

  // Glob all .md files in the skill directory
  const allMdFiles = fs.globSync('**/*.md', { cwd: skillDir });

  for (const relPath of allMdFiles) {
    const absPath = resolve(skillDir, relPath);
    const fileName = basename(relPath);

    // Skip excluded patterns
    if (UNREFERENCED_EXCLUDE_PATTERNS.has(fileName)) {
      continue;
    }

    // Skip files that were visited during traversal
    if (visitedPaths.has(absPath)) {
      continue;
    }

    issues.push({
      severity: 'info',
      code: 'SKILL_UNREFERENCED_FILE',
      message: `Markdown file not referenced from SKILL.md link graph: ${relPath}`,
      location: absPath,
      fix: 'Add a link to this file from SKILL.md or a linked document, or remove the file',
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
