import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { toForwardSlash } from '@vibe-agent-toolkit/utils';

import { parseFrontmatter } from '../parsers/frontmatter-parser.js';
import { ClaudeSkillFrontmatterSchema, VATClaudeSkillFrontmatterSchema } from '../schemas/claude-skill-frontmatter.js';

import type { LinkedFileValidationResult, ValidateOptions, ValidationIssue, ValidationResult } from './types.js';

// Location constants for validation messages
const FRONTMATTER_LOC = 'frontmatter';
const FRONTMATTER_NAME_LOC = 'frontmatter.name';
const FRONTMATTER_DESC_LOC = 'frontmatter.description';

// Directories to ignore when checking for unreferenced files
const IGNORED_DIRS = new Set([
  // Dependencies
  'node_modules',
  'venv', '.venv', 'env', '.env',
  '__pycache__',
  'site-packages',
  '.tox',

  // Build artifacts
  'dist', 'build', '.next', 'out',
  'target',
  '.turbo', '.parcel-cache',

  // Version control
  '.git', '.github', '.gitlab',
  '.svn', '.hg',

  // IDE
  '.vscode', '.idea', '.vs',
]);

// Files to ignore when checking for unreferenced files
const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db',
  '.gitignore', '.dockerignore',
  '.eslintrc', '.prettierrc',
  'package-lock.json', 'bun.lockb',
  'poetry.lock', 'Pipfile.lock',
  '.tsbuildinfo',
]);

/**
 * Validate a Claude Skill (SKILL.md file) with transitive validation of linked markdown files
 *
 * @param options - Validation options
 * @returns Validation result with issues from SKILL.md and all transitively linked markdown files
 */
export async function validateSkill(options: ValidateOptions): Promise<ValidationResult> {
  const { skillPath, rootDir = path.dirname(skillPath), isVATGenerated = false, checkUnreferencedFiles = false } = options;

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

  // Extract and validate links transitively
  const linkedFiles = await validateLinksTransitively(skillPath, rootDir, issues);

  // Check warning-level rules
  validateWarningRules(content, lineCount, skillPath, issues);

  // Check for unreferenced files if enabled
  if (checkUnreferencedFiles) {
    const skillDir = path.dirname(skillPath);
    // Collect all markdown content for reference detection
    const allMarkdownContent = [content];
    for (const linkedFile of linkedFiles) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- linkedFile.path comes from validated links
      if (fs.existsSync(linkedFile.path)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- linkedFile.path validated above
        allMarkdownContent.push(fs.readFileSync(linkedFile.path, 'utf-8'));
      }
    }
    await detectUnreferencedFiles(skillDir, allMarkdownContent.join('\n'), issues);
  }

  // Build metadata object
  const metadata = buildMetadata(frontmatter, lineCount);

  // Update metadata with reference file count
  if (linkedFiles.length > 0 && metadata) {
    metadata.referenceFiles = linkedFiles.length;
  }

  const result = buildResult(skillPath, isVATGenerated, issues, metadata);

  // Add linked files if any were validated
  if (linkedFiles.length > 0) {
    result.linkedFiles = linkedFiles;
  }

  return result;
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

/**
 * Process links from the main SKILL.md file.
 * Validates each link and adds valid markdown files to the processing queue.
 */
async function processSkillFileLinks(
  skillPath: string,
  rootDir: string,
  issues: ValidationIssue[],
  queue: string[]
): Promise<void> {
  const parsed = await parseMarkdown(skillPath);
  const localLinks = parsed.links.filter(link => link.type === 'local_file');

  for (const link of localLinks) {
    const resolvedPath = resolveLinkPath(link.href, skillPath, rootDir);

    validateSingleLink(
      { text: link.text, path: link.href, line: link.line ?? 0 },
      skillPath,
      rootDir,
      issues
    );

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedPath is constructed from validated inputs
    if (resolvedPath && isMarkdownFile(resolvedPath) && fs.existsSync(resolvedPath)) {
      queue.push(resolvedPath);
    }
  }
}

/**
 * Process the queue of linked markdown files using BFS traversal.
 * Validates each file and collects links for further processing.
 */
async function processLinkedFilesQueue(
  queue: string[],
  validatedFiles: Set<string>,
  linkedFileResults: LinkedFileValidationResult[],
  rootDir: string
): Promise<void> {
  while (queue.length > 0) {
    const currentFilePath = queue.shift();
    if (!currentFilePath || validatedFiles.has(currentFilePath)) {
      continue;
    }

    validatedFiles.add(currentFilePath);

    const fileResult = await validateLinkedMarkdownFile(currentFilePath, rootDir);
    linkedFileResults.push(fileResult);

    await collectLinksFromFile(currentFilePath, rootDir, queue);
  }
}

/**
 * Extract and collect links from a linked markdown file.
 * Adds valid markdown file links to the processing queue.
 */
async function collectLinksFromFile(
  filePath: string,
  rootDir: string,
  queue: string[]
): Promise<void> {
  try {
    const parsed = await parseMarkdown(filePath);
    const localLinks = parsed.links.filter(link => link.type === 'local_file');

    for (const link of localLinks) {
      const resolvedPath = resolveLinkPath(link.href, filePath, rootDir);

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolvedPath is constructed from validated inputs
      if (resolvedPath && isMarkdownFile(resolvedPath) && fs.existsSync(resolvedPath)) {
        queue.push(resolvedPath);
      }
    }
  } catch {
    // If we can't parse the file, skip collecting its links
    // (error already recorded in file validation)
  }
}

/**
 * Validate links transitively, starting from SKILL.md and following all local markdown links.
 *
 * Uses BFS to traverse the link graph and validates each linked markdown file.
 * Tracks validated files to avoid re-processing and handle circular references.
 *
 * @param skillPath - Path to SKILL.md
 * @param rootDir - Root directory for resolving links
 * @issues - Issues array to append SKILL.md link validation issues
 * @returns Array of validation results for all linked markdown files
 */
async function validateLinksTransitively(
  skillPath: string,
  rootDir: string,
  issues: ValidationIssue[]
): Promise<LinkedFileValidationResult[]> {
  const linkedFileResults: LinkedFileValidationResult[] = [];
  const validatedFiles = new Set<string>(); // Track validated files by absolute path
  const queue: string[] = []; // Queue of markdown files to process

  // Parse SKILL.md and validate/collect its links
  await processSkillFileLinks(skillPath, rootDir, issues, queue);

  // BFS traversal of linked markdown files
  await processLinkedFilesQueue(queue, validatedFiles, linkedFileResults, rootDir);

  return linkedFileResults;
}

/**
 * Validate a single linked markdown file (not SKILL.md).
 *
 * Checks link integrity and collects statistics about the file.
 *
 * @param filePath - Absolute path to the markdown file
 * @param rootDir - Root directory for resolving links
 * @returns Validation result with issues and metadata
 */
async function validateLinkedMarkdownFile(
  filePath: string,
  rootDir: string
): Promise<LinkedFileValidationResult> {
  const fileIssues: ValidationIssue[] = [];

  // Read file
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is validated before calling
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      lineCount: 0,
      linksFound: 0,
      linksValidated: 0,
      issues: [{
        severity: 'error',
        code: 'LINK_INTEGRITY_BROKEN',
        message: 'File does not exist',
        location: filePath,
      }],
    };
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath validated above
  const content = fs.readFileSync(filePath, 'utf-8');
  const lineCount = content.split('\n').length;

  // Parse markdown
  let parsed;
  try {
    parsed = await parseMarkdown(filePath);
  } catch (error) {
    return {
      path: filePath,
      lineCount,
      linksFound: 0,
      linksValidated: 0,
      issues: [{
        severity: 'error',
        code: 'LINK_INTEGRITY_BROKEN',
        message: `Failed to parse markdown: ${error instanceof Error ? error.message : String(error)}`,
        location: filePath,
      }],
    };
  }

  // Filter to local file links
  const localLinks = parsed.links.filter(link => link.type === 'local_file');
  const linksFound = localLinks.length;
  let linksValidated = 0;

  // Validate each link
  for (const link of localLinks) {
    const beforeCount = fileIssues.length;
    validateSingleLink(
      { text: link.text, path: link.href, line: link.line ?? 0 },
      filePath,
      rootDir,
      fileIssues
    );
    // If no issue was added, the link is valid
    if (fileIssues.length === beforeCount) {
      linksValidated++;
    }
  }

  // Check warning-level rules
  validateWarningRules(content, lineCount, filePath, fileIssues);

  return {
    path: filePath,
    lineCount,
    linksFound,
    linksValidated,
    issues: fileIssues,
  };
}

/**
 * Resolve a link path to an absolute path.
 *
 * @param linkHref - The raw href from the markdown link
 * @param sourceFile - The file containing the link
 * @param rootDir - Root directory for absolute links
 * @returns Resolved absolute path, or undefined if the link is not a local file
 */
function resolveLinkPath(linkHref: string, sourceFile: string, rootDir: string): string | undefined {
  // Skip external and anchor links
  if (linkHref.startsWith('http://') || linkHref.startsWith('https://') || linkHref.startsWith('#')) {
    return undefined;
  }

  // Skip Windows-style paths (they'll be caught by validation)
  if (linkHref.includes('\\')) {
    return undefined;
  }

  // Resolve absolute or relative path
  if (linkHref.startsWith('/')) {
    return path.join(rootDir, linkHref);
  }

  return path.resolve(path.dirname(sourceFile), linkHref);
}

/**
 * Check if a file path is a markdown file.
 *
 * @param filePath - File path to check
 * @returns True if the file has a markdown extension
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.md' || ext === '.markdown';
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

/**
 * Detect files in skill directory that aren't referenced in any markdown content
 *
 * @param skillDir - Root directory of the skill
 * @param markdownContent - All validated markdown content
 * @param issues - Array to append issues to
 */
async function detectUnreferencedFiles(
  skillDir: string,
  markdownContent: string,
  issues: ValidationIssue[]
): Promise<void> {
  // Get all files in skill directory recursively
  const allFiles = enumerateFiles(skillDir);

  // Filter files through smart filtering
  const candidateFiles = allFiles.filter(filePath => {
    const relativePath = path.relative(skillDir, filePath);
    const pathParts = toForwardSlash(relativePath).split('/');

    // Check if any part of the path is an ignored directory
    if (pathParts.some(part => IGNORED_DIRS.has(part))) {
      return false;
    }

    // Check if filename is ignored
    const fileName = path.basename(filePath);
    if (IGNORED_FILES.has(fileName)) {
      return false;
    }

    return true;
  });

  // Check each candidate file for references in markdown content
  for (const filePath of candidateFiles) {
    const relativePath = path.relative(skillDir, filePath);

    if (!isReferencedInContent(relativePath, markdownContent)) {
      issues.push({
        severity: 'info',
        code: 'SKILL_UNREFERENCED_FILE',
        message: `File not referenced in any skill markdown: ${relativePath}`,
        location: filePath,
        fix: 'Add reference to file or remove if unused',
      });
    }
  }
}

/**
 * Recursively enumerate all files in a directory
 *
 * @param dir - Directory to enumerate
 * @returns Array of absolute file paths
 */
function enumerateFiles(dir: string): string[] {
  const results: string[] = [];

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is from validated skill path
  if (!fs.existsSync(dir)) {
    return results;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir validated above
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recursively enumerate subdirectory
      results.push(...enumerateFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Check if a file path is referenced in markdown content
 *
 * @param relativePath - Relative path from skill directory
 * @param content - Markdown content to search
 * @returns True if path appears in content
 */
function isReferencedInContent(relativePath: string, content: string): boolean {
  // Normalize path to forward slashes for cross-platform compatibility
  // (markdown always uses forward slashes, but path.relative() uses OS separators)
  const normalizedPath = toForwardSlash(relativePath);

  // Generate variations of the path to check
  const variations = [
    normalizedPath,                    // bare: scripts/build.sh
    `\`${normalizedPath}\``,          // backtick: `scripts/build.sh`
    `"${normalizedPath}"`,            // double quote
    `'${normalizedPath}'`,            // single quote
    `./${normalizedPath}`,            // relative prefix
    ` ${normalizedPath} `,            // with spaces
    ` ${normalizedPath}`,
    `${normalizedPath} `,
  ];

  return variations.some(v => content.includes(v));
}
