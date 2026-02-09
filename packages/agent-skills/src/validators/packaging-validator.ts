/**
 * Enhanced skill validation for packaging
 *
 * Extends basic skill validation with:
 * - Size/complexity validation (SKILL.md lines, total lines, file count)
 * - Link depth analysis (prevent deep nesting)
 * - Navigation file detection (README.md, index.md patterns)
 * - Override support (ignoreValidationErrors configuration)
 * - Expiration checking (time-limited overrides)
 *
 * Used by:
 * - vat skills validate (report errors, exit 1 on failure)
 * - vat skills build (block build on validation errors)
 * - vat skills audit --user (report issues, exit 0 always)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { ValidationOverride, VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';
import { parseMarkdown } from '@vibe-agent-toolkit/resources';

import { collectLinks } from '../link-collector.js';

import type { ValidationIssue } from './types.js';
import {
  createIssue,
  isOverridable,
  NAVIGATION_FILE_PATTERNS,
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
  type ValidationRuleCode,
} from './validation-rules.js';

/**
 * Enhanced validation result with override support
 */
export interface PackagingValidationResult {
  /** Skill name */
  skillName: string;

  /** Validation status */
  status: 'success' | 'error';

  /** All validation errors (before override filtering) */
  allErrors: ValidationIssue[];

  /** Active errors (not ignored by overrides) */
  activeErrors: ValidationIssue[];

  /** Ignored errors (suppressed by valid overrides) */
  ignoredErrors: Array<{
    error: ValidationIssue;
    reason: string;
  }>;

  /** Expired overrides (no longer valid) */
  expiredOverrides: Array<{
    error: ValidationIssue;
    reason: string;
    expiredDate: string;
  }>;

  /** Metadata about the skill */
  metadata: {
    skillLines: number;
    totalLines: number;
    fileCount: number;
    directFileCount: number;
    maxLinkDepth: number;
    excludedReferenceCount: number;
    excludedReferences: string[];
  };
}

/**
 * Validate a skill for packaging
 *
 * Performs comprehensive validation including:
 * - Size/complexity checks
 * - Link depth analysis
 * - Navigation file detection
 * - Override application
 *
 * @param skillPath - Path to SKILL.md
 * @param skillMetadata - Optional skill metadata (for overrides)
 * @returns Validation result with active and ignored errors
 */
export async function validateSkillForPackaging(
  skillPath: string,
  skillMetadata?: VatSkillMetadata
): Promise<PackagingValidationResult> {
  const errors: ValidationIssue[] = [];

  // Parse SKILL.md
  const parseResult = await parseMarkdown(skillPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillPath is validated function parameter
  const skillContent = await readFile(skillPath, 'utf-8');
  const skillLines = skillContent.split('\n').length;

  // Count files linked directly from SKILL.md (not transitively)
  const directLinks = getResolvedMarkdownLinks(parseResult.links, skillPath);
  const directFileCount = directLinks.length;

  // Read packaging options for depth/exclude configuration
  const linkFollowDepth = skillMetadata?.packagingOptions?.linkFollowDepth ?? 2;
  const excludeConfig = skillMetadata?.packagingOptions?.excludeReferencesFromBundle;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Collect linked files with depth + exclusion
  const { bundledFiles, excludedReferences, maxBundledDepth } = await collectLinks(
    skillPath,
    {
      maxDepth,
      excludeRules: excludeConfig?.rules ?? [],
      defaultRule: excludeConfig?.default ?? { handling: 'strip-to-text' },
      skillRoot: dirname(skillPath),
    }
  );

  const fileCount = bundledFiles.length + 1; // +1 for SKILL.md itself
  const maxLinkDepth = maxBundledDepth;

  // Calculate total lines from bundled markdown files only
  let totalLines = skillLines;
  for (const bundledFile of bundledFiles) {
    if (bundledFile.endsWith('.md')) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bundledFile resolved from markdown parser
      const content = await readFile(bundledFile, 'utf-8');
      totalLines += content.split('\n').length;
    }
  }

  // Deduplicate excluded reference paths for metadata
  const uniqueExcludedPaths = [...new Set(excludedReferences.map(r => r.path))];

  // Run validation checks
  await validateSkillSize(skillLines, skillPath, errors);
  await validateTotalSize(totalLines, fileCount, skillPath, errors);
  await validateFileCount(fileCount, skillPath, errors);
  await validateLinkDepth(maxLinkDepth, skillPath, errors);
  await validateNavigationLinks(parseResult.links, skillPath, errors);
  await validateDescription(parseResult.frontmatter, skillPath, errors);
  await validateProgressiveDisclosure(skillLines, bundledFiles.length, skillPath, errors);

  // Apply overrides
  const skillName = extractSkillName(parseResult, skillPath);
  const overrides = skillMetadata?.ignoreValidationErrors ?? {};

  const { activeErrors, ignoredErrors, expiredOverrides } = applyOverrides(errors, overrides);

  return {
    skillName,
    status: activeErrors.length > 0 ? 'error' : 'success',
    allErrors: errors,
    activeErrors,
    ignoredErrors,
    expiredOverrides,
    metadata: {
      skillLines,
      totalLines,
      fileCount,
      directFileCount,
      maxLinkDepth,
      excludedReferenceCount: uniqueExcludedPaths.length,
      excludedReferences: uniqueExcludedPaths,
    },
  };
}

/**
 * Validate SKILL.md size
 */
async function validateSkillSize(
  lines: number,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  if (lines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES) {
    const rule = VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED;
    errors.push(createIssue(rule, { lines }, skillPath));
  }
}

/**
 * Validate total skill size
 */
async function validateTotalSize(
  totalLines: number,
  _fileCount: number,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  if (totalLines > VALIDATION_THRESHOLDS.MAX_TOTAL_LINES) {
    const rule = VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE;
    errors.push(createIssue(rule, { totalLines }, skillPath));
  }
}

/**
 * Validate file count
 */
async function validateFileCount(
  fileCount: number,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  if (fileCount > VALIDATION_THRESHOLDS.MAX_FILE_COUNT) {
    const rule = VALIDATION_RULES.SKILL_TOO_MANY_FILES;
    errors.push(createIssue(rule, { fileCount }, skillPath));
  }
}

/**
 * Validate link depth
 */
async function validateLinkDepth(
  depth: number,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  if (depth > VALIDATION_THRESHOLDS.MAX_REFERENCE_DEPTH) {
    const rule = VALIDATION_RULES.REFERENCE_TOO_DEEP;
    errors.push(createIssue(rule, { depth }, skillPath));
  }
}

/**
 * Validate navigation links
 */
async function validateNavigationLinks(
  links: Array<{ href: string; type: string; line?: number | undefined; text?: string | undefined }>,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  const navigationLinks = links
    .filter((link) => link.type === 'local_file')
    .filter((link) => {
      const filename = basename(link.href);
      return (NAVIGATION_FILE_PATTERNS as readonly string[]).includes(filename);
    });

  if (navigationLinks.length > 0) {
    const files = navigationLinks.map((l) => {
      const hrefBase = l.href.split('#')[0] ?? l.href;
      const resolvedPath = resolve(dirname(skillPath), hrefBase);
      const lineInfo = l.line === undefined ? '' : `:${l.line}`;
      return `${resolvedPath}${lineInfo}`;
    }).join(', ');
    const rule = VALIDATION_RULES.LINKS_TO_NAVIGATION_FILES;
    errors.push(createIssue(rule, { files }, skillPath));
  }
}

/**
 * Validate description
 */
async function validateDescription(
  frontmatter: Record<string, unknown> | undefined,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  const description = frontmatter?.['description'];

  if (!description || typeof description !== 'string') {
    return; // Missing description is handled by existing validator
  }

  if (description.length < VALIDATION_THRESHOLDS.MIN_DESCRIPTION_LENGTH) {
    const rule = VALIDATION_RULES.DESCRIPTION_TOO_VAGUE;
    errors.push(createIssue(rule, { length: description.length }, skillPath));
  }
}

/**
 * Validate progressive disclosure pattern
 */
async function validateProgressiveDisclosure(
  skillLines: number,
  referenceFileCount: number,
  skillPath: string,
  errors: ValidationIssue[]
): Promise<void> {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES && referenceFileCount === 0) {
    const rule = VALIDATION_RULES.NO_PROGRESSIVE_DISCLOSURE;
    errors.push(createIssue(rule, { lines: skillLines }, skillPath));
  }
}

/**
 * Process links from parsed markdown and return resolved .md file paths
 */
function getResolvedMarkdownLinks(
  links: Array<{ href: string; type: string }>,
  markdownPath: string
): string[] {
  const resolvedPaths: string[] = [];

  for (const link of links) {
    if (link.type !== 'local_file') {
      continue;
    }

    // Remove anchor
    const hrefWithoutAnchor = link.href.split('#')[0] ?? link.href;
    if (hrefWithoutAnchor === '') {
      continue;
    }

    // Resolve path
    const resolvedPath = resolve(dirname(markdownPath), hrefWithoutAnchor);

    // Only include .md files that exist
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from parsed markdown
    if (!resolvedPath.endsWith('.md') || !existsSync(resolvedPath)) {
      continue;
    }

    resolvedPaths.push(resolvedPath);
  }

  return resolvedPaths;
}

/**
 * Extract skill name from parse result
 */
function extractSkillName(
  parseResult: { frontmatter?: Record<string, unknown>; content: string },
  skillPath: string
): string {
  // Try frontmatter name
  const frontmatterName = parseResult.frontmatter?.['name'];
  if (frontmatterName && typeof frontmatterName === 'string') {
    return frontmatterName;
  }

  // Try H1 title (use [^\n] instead of .+ to avoid backtracking)
  // eslint-disable-next-line sonarjs/slow-regex -- Using [^\n]+ instead of .+ to avoid backtracking
  const h1Match = /^#\s+([^\n]+)$/m.exec(parseResult.content);
  if (h1Match?.[1]) {
    return h1Match[1].trim();
  }

  // Fall back to filename
  return basename(skillPath, '.md');
}

/**
 * Apply validation overrides
 */
function applyOverrides(
  errors: ValidationIssue[],
  overrides: Record<string, ValidationOverride>
): {
  activeErrors: ValidationIssue[];
  ignoredErrors: Array<{ error: ValidationIssue; reason: string }>;
  expiredOverrides: Array<{ error: ValidationIssue; reason: string; expiredDate: string }>;
} {
  const activeErrors: ValidationIssue[] = [];
  const ignoredErrors: Array<{ error: ValidationIssue; reason: string }> = [];
  const expiredOverrides: Array<{ error: ValidationIssue; reason: string; expiredDate: string }> = [];

  for (const error of errors) {
    const override = overrides[error.code];

    // No override - error is active
    if (!override) {
      activeErrors.push(error);
      continue;
    }

    // Check if error code is overridable
    if (!isOverridable(error.code as ValidationRuleCode)) {
      // Non-overridable rule - error is active
      activeErrors.push(error);
      continue;
    }

    // Parse override
    const { reason, expires } = typeof override === 'string' ? { reason: override, expires: undefined } : override;

    // Check expiration
    if (expires) {
      const expirationDate = new Date(expires);
      const now = new Date();

      if (now > expirationDate) {
        // Override expired - error is active
        expiredOverrides.push({ error, reason, expiredDate: expires });
        activeErrors.push(error);
        continue;
      }
    }

    // Valid override - error is ignored
    ignoredErrors.push({ error, reason });
  }

  return { activeErrors, ignoredErrors, expiredOverrides };
}
