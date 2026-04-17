import * as fs from 'node:fs';
import { basename, dirname } from 'node:path';

import { parseMarkdown, resolveLocalHref } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';


import { parseFrontmatter } from '../parsers/frontmatter-parser.js';

import { runCompatDetectors } from './compat-detectors.js';
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

  // Compat smells (warning-severity; flows through validation.allow like other framework codes)
  issues.push(...runCompatDetectors(content, skillPath));

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
  // Resolve href to filesystem path (strips anchor, decodes percent-encoding)
  const resolved = resolveLocalHref(link.href, currentPath);
  if (!resolved) {
    return { status: 'skip', resolvedPath: '' };
  }

  const resolvedPath = resolved.resolvedPath;
  const relativeToBoundary = safePath.relative(skillDir, resolvedPath);

  // Check boundary escape
  if (relativeToBoundary.startsWith('..')) {
    const issue: ValidationIssue = {
      severity: 'warning',
      code: 'LINK_OUTSIDE_PROJECT',
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
  const resolvedSkillPath = safePath.resolve(skillPath);
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

    // Compat smells for linked files (root SKILL.md handled by the top-level invocation).
    // Re-read raw file content so fenced code blocks remain intact for detectors.
    if (currentPath !== resolvedSkillPath) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- currentPath verified existent by BFS predecessor
      const linkedContent = fs.readFileSync(currentPath, 'utf-8');
      const linkedCompatIssues = runCompatDetectors(linkedContent, currentPath);
      processed.fileIssues.push(...linkedCompatIssues);
      issues.push(...linkedCompatIssues);
    }

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
  const visitedPaths = new Set<string>([safePath.resolve(skillPath)]);
  for (const lf of linkedFiles) {
    visitedPaths.add(lf.path);
  }

  // Glob all .md files in the skill directory
  const allMdFiles = fs.globSync('**/*.md', { cwd: skillDir });

  const unreferencedFiles: string[] = [];

  for (const relPath of allMdFiles) {
    const absPath = safePath.resolve(skillDir, relPath);
    const fileName = basename(relPath);

    // Skip excluded patterns
    if (UNREFERENCED_EXCLUDE_PATTERNS.has(fileName)) {
      continue;
    }

    // Skip files that were visited during traversal
    if (visitedPaths.has(absPath)) {
      continue;
    }

    unreferencedFiles.push(relPath);
  }

  // Check for implicit references among unreferenced files
  const implicitRefs = extractImplicitReferences(skillDir, unreferencedFiles, visitedPaths);

  for (const relPath of unreferencedFiles) {
    const absPath = safePath.resolve(skillDir, relPath);

    const ref = implicitRefs.find((r) => r.referencedFile === relPath);
    if (ref) {
      issues.push({
        severity: 'info',
        code: 'SKILL_IMPLICIT_REFERENCE',
        message: `File implicitly referenced (not via markdown link) in ${basename(ref.foundIn)}: ${ref.matchedText}`,
        location: absPath,
        fix: 'Consider using a standard markdown link [text](path) for better tooling support',
      });
    } else {
      issues.push({
        severity: 'info',
        code: 'SKILL_UNREFERENCED_FILE',
        message: `Markdown file not referenced from SKILL.md link graph: ${relPath}`,
        location: absPath,
        fix: 'Add a link to this file from SKILL.md or a linked document, or remove the file',
      });
    }
  }
}

// ============================================================================
// Implicit Reference Detection
// ============================================================================

/** Result of finding an implicit (non-markdown-link) reference to a file */
export interface ImplicitReference {
  /** Relative path of the referenced file (e.g., "references/domain-template.md") */
  referencedFile: string;
  /** Absolute path of the file containing the reference */
  foundIn: string;
  /** The matched text snippet (for diagnostics) */
  matchedText: string;
  /** Line number where found (1-based) */
  line: number;
}

/** Characters that can appear immediately before/after a file path in text */
const BOUNDARY_CHARS = new Set([
  ' ', '\t',        // whitespace
  '`',              // backtick (inline code)
  '(', ')',         // parentheses
  '"', "'",         // quotes
  '@',              // Claude force-load prefix
  '*',              // bold/italic markers
  '[', ']',         // brackets
  ':', ',', ';',    // punctuation (colon, comma, semicolon)
  '.', '!', '?',   // sentence-ending punctuation after "see filename.md."
]);

/**
 * Check if a candidate path appears as a self-contained reference at position `index` in `line`.
 * The character before and after the candidate must be a boundary character, or BOL/EOL.
 */
function isSelfContainedMatch(line: string, index: number, candidateLength: number): boolean {
  // Check character before (BOL is ok)
  if (index > 0 && !BOUNDARY_CHARS.has(line.charAt(index - 1))) {
    return false;
  }

  // Check character after (EOL is ok)
  const afterIndex = index + candidateLength;
  if (afterIndex < line.length && !BOUNDARY_CHARS.has(line.charAt(afterIndex))) {
    return false;
  }

  return true;
}

/**
 * Check if the match is inside a URL (contains :// nearby)
 */
function isInsideUrl(line: string, index: number): boolean {
  // Look for :// pattern before the match (within reasonable distance)
  const lookback = line.slice(Math.max(0, index - 100), index);
  return lookback.includes('://');
}

/**
 * Build a map of candidate search strings to their source file paths.
 * Each unreferenced file generates 2-3 candidate strings.
 */
function buildCandidateMap(
  unreferencedFiles: readonly string[],
): Map<string, string> {
  const candidates = new Map<string, string>();

  // Count basenames to detect ambiguity
  const basenameCounts = new Map<string, number>();
  for (const relPath of unreferencedFiles) {
    const base = basename(relPath);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }

  for (const relPath of unreferencedFiles) {
    // Always add the relative path as-is
    candidates.set(relPath, relPath);

    // Add ./prefixed variant
    candidates.set(`./${relPath}`, relPath);

    // Add basename only if unambiguous
    const base = basename(relPath);
    if (base !== relPath && (basenameCounts.get(base) ?? 0) <= 1) {
      candidates.set(base, relPath);
    }
  }

  return candidates;
}

/**
 * Find the first self-contained, non-URL occurrence of `candidate` in `line`.
 * Returns the match index or -1 if no valid match found.
 */
function findBoundedMatch(line: string, candidate: string): number {
  let searchFrom = 0;
  let matchIndex: number;

  while ((matchIndex = line.indexOf(candidate, searchFrom)) !== -1) {
    searchFrom = matchIndex + 1;

    if (isSelfContainedMatch(line, matchIndex, candidate.length) && !isInsideUrl(line, matchIndex)) {
      return matchIndex;
    }
  }

  return -1;
}

/**
 * Scan a single file's lines for implicit references to unreferenced files.
 */
function scanFileForReferences(
  visitedPath: string,
  candidates: Map<string, string>,
  results: ImplicitReference[],
): void {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- visitedPath from BFS traversal
    content = fs.readFileSync(visitedPath, 'utf-8');
  } catch {
    return; // File unreadable, skip
  }

  const lines = content.split('\n');
  for (const [lineIndex, line] of lines.entries()) {
    for (const [candidate, referencedFile] of candidates) {
      const matchIndex = findBoundedMatch(line, candidate);
      if (matchIndex === -1) {
        continue;
      }

      // Extract a reasonable snippet around the match
      const snippetStart = Math.max(0, matchIndex - 20);
      const snippetEnd = Math.min(line.length, matchIndex + candidate.length + 20);
      const matchedText = line.slice(snippetStart, snippetEnd).trim();

      results.push({
        referencedFile,
        foundIn: visitedPath,
        matchedText,
        line: lineIndex + 1,
      });
    }
  }
}

/**
 * Scan BFS-visited files for implicit (non-markdown-link) references to unreferenced files.
 *
 * "Implicit reference" means the file path appears in the text bounded by delimiter
 * characters (backticks, parens, whitespace, etc.) but NOT as a standard markdown link.
 *
 * @param skillDir - Absolute path to the skill directory
 * @param unreferencedFiles - Relative paths of .md files not found by BFS traversal
 * @param visitedFiles - Absolute paths of files visited during BFS (to scan for references)
 * @returns Array of implicit references found
 */
export function extractImplicitReferences(
  _skillDir: string,
  unreferencedFiles: readonly string[],
  visitedFiles: ReadonlySet<string>,
): ImplicitReference[] {
  if (unreferencedFiles.length === 0) {
    return [];
  }

  const candidates = buildCandidateMap(unreferencedFiles);
  const results: ImplicitReference[] = [];

  for (const visitedPath of visitedFiles) {
    scanFileForReferences(visitedPath, candidates, results);
  }

  return results;
}

function validateWarningRules(
  _content: string,
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
