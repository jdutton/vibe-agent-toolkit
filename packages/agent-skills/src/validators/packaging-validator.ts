/**
 * Enhanced skill validation for packaging
 *
 * Extends basic skill validation with:
 * - Size/complexity validation (SKILL.md lines, total lines, file count)
 * - Link depth analysis (prevent deep nesting)
 * - Navigation file detection (README.md, index.md patterns)
 * - Framework-based severity / allow config (validation.severity, validation.allow)
 *
 * Used by:
 * - vat skills validate (report errors, exit 1 on failure)
 * - vat skills build (block build on validation errors)
 * - vat skills audit --user (report issues, exit 0 always)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { parseMarkdown, ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { findProjectRoot, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';

import { walkLinkGraph, type LinkResolution, type WalkableRegistry } from '../walk-link-graph.js';

import type { AllowRecord } from './allow-filter.js';
import { CODE_REGISTRY, type IssueCode } from './code-registry.js';
import { validateFrontmatterRules, validateFrontmatterSchema } from './frontmatter-validation.js';
import { SOURCE_ONLY_CODES } from './source-only-codes.js';
import type { ValidationIssue } from './types.js';
import { runValidationFramework, type ValidationConfig } from './validation-framework.js';
import {
  VALIDATION_RULES,
  VALIDATION_THRESHOLDS,
} from './validation-rules.js';
import { walkerExclusionsToIssues } from './walker-to-issues.js';

/** Exclude reason constants to avoid duplicate string literals */
const EXCLUDE_REASON_DIRECTORY = 'directory-target' as const;
const EXCLUDE_REASON_OUTSIDE_PROJECT = 'outside-project' as const;
const DETAIL_REASON_DEPTH: ExcludedReferenceDetail['reason'] = 'depth-exceeded';

/**
 * Packaging configuration for skill validation.
 * Replaces the old VatSkillMetadata parameter — accepts packaging options directly.
 */
export interface SkillPackagingConfig {
  linkFollowDepth?: number | 'full';
  resourceNaming?: 'basename' | 'resource-id' | 'preserve-path';
  stripPrefix?: string;
  excludeNavigationFiles?: boolean;
  excludeReferencesFromBundle?: {
    rules?: Array<{ patterns: string[]; template?: string }>;
    defaultTemplate?: string;
  };
  files?: Array<{ source: string; dest: string }>;
  /** Framework-based validation configuration (severity overrides and allow entries). */
  validation?: ValidationConfig | undefined;
}

/** Excluded reference detail for verbose output */
export interface ExcludedReferenceDetail {
  path: string;
  reason: 'depth-exceeded' | 'pattern-matched' | 'outside-project' | 'navigation-file' | 'skill-definition' | 'gitignored';
  matchedPattern?: string | undefined;
}

/**
 * Enhanced validation result using the unified framework
 */
export interface PackagingValidationResult {
  /** Skill name */
  skillName: string;

  /** Validation status */
  status: 'success' | 'error';

  /** All emitted issues after severity resolution (errors + warnings) */
  allErrors: ValidationIssue[];

  /** Active errors (severity === 'error', not suppressed by allow) */
  activeErrors: ValidationIssue[];

  /** Active warnings (severity === 'warning', not suppressed by allow) */
  activeWarnings: ValidationIssue[];

  /** Issues suppressed by allow entries */
  ignoredErrors: AllowRecord[];

  /** Metadata about the skill */
  metadata: {
    skillLines: number;
    totalLines: number;
    fileCount: number;
    directFileCount: number;
    maxLinkDepth: number;
    excludedReferenceCount: number;
    excludedReferences: ExcludedReferenceDetail[];
  };
}

/**
 * Validate files config entries for duplicate dest values.
 */
function validateFilesConfig(
  files: Array<{ source: string; dest: string }> | undefined,
): ValidationIssue[] {
  if (!files?.length) return [];

  const issues: ValidationIssue[] = [];
  const destSet = new Set<string>();

  for (const entry of files) {
    const normalized = toForwardSlash(entry.dest);
    if (destSet.has(normalized)) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_FILES_DEST',
        message: `Duplicate dest '${entry.dest}' in files config. Each dest must be unique.`,
      });
    }
    destSet.add(normalized);
  }

  return issues;
}

/**
 * Create a validation issue from a code-registry code
 */
function createRegistryIssue(
  code: IssueCode,
  message: string,
  location?: string,
): ValidationIssue {
  const entry = CODE_REGISTRY[code];
  const issue: ValidationIssue = {
    severity: entry.defaultSeverity,
    code,
    message,
    fix: entry.fix,
    reference: entry.reference,
  };
  if (location !== undefined) {
    issue.location = location;
  }
  return issue;
}

/**
 * Validate a skill for packaging
 *
 * Performs comprehensive validation including:
 * - Size/complexity checks
 * - Link depth analysis
 * - Navigation file detection
 * - Framework-based severity / allow config
 *
 * @param skillPath - Path to SKILL.md
 * @param packagingConfig - Optional packaging configuration (depth, excludes, validation)
 * @returns Validation result with active errors, warnings, and allowed issues
 */
export async function validateSkillForPackaging(
  skillPath: string,
  packagingConfig?: SkillPackagingConfig,
  context: 'source' | 'built' = 'source',
): Promise<PackagingValidationResult> {
  const rawIssues: ValidationIssue[] = [];

  // Parse SKILL.md
  const parseResult = await parseMarkdown(skillPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillPath is validated function parameter
  const skillContent = await readFile(skillPath, 'utf-8');
  const skillLines = skillContent.split('\n').length;

  // Validate frontmatter schema (name format, required fields, etc.)
  if (parseResult.frontmatter) {
    rawIssues.push(
      ...validateFrontmatterSchema(parseResult.frontmatter, false),
      ...validateFrontmatterRules(parseResult.frontmatter),
    );
  }

  // Validate files config
  rawIssues.push(...validateFilesConfig(packagingConfig?.files));

  // Read packaging options for depth/exclude configuration
  const linkFollowDepth = packagingConfig?.linkFollowDepth ?? 2;
  const excludeConfig = packagingConfig?.excludeReferencesFromBundle;
  const excludeNavigationFiles = packagingConfig?.excludeNavigationFiles ?? true;
  const maxDepth = linkFollowDepth === 'full' ? Infinity : linkFollowDepth;

  // Find project boundary (workspace root -> git root -> skill dir)
  const projectRoot = findProjectRoot(dirname(skillPath));

  // Build resource registry and walk the link graph
  const registry = await ResourceRegistry.fromCrawl({
    baseDir: projectRoot,
    include: ['**/*.md'],
  });
  registry.resolveLinks();

  const skillResource = registry.getResource(safePath.resolve(skillPath));
  const { bundledResources, bundledAssets, excludedReferences, maxBundledDepth } = walkLinkGraph(
    skillResource?.id ?? '',
    registry as WalkableRegistry,
    {
      maxDepth,
      excludeRules: excludeConfig?.rules ?? [],
      projectRoot,
      skillRootPath: safePath.resolve(skillPath),
      excludeNavigationFiles,
    },
  );
  const bundledFiles = [...bundledResources.map(r => r.filePath), ...bundledAssets];

  // Count direct links that actually made it into the bundle
  const directLinks = getResolvedMarkdownLinks(parseResult.links, skillPath);
  const bundledFileSet = new Set(bundledFiles);
  const directFileCount = directLinks.filter(p => bundledFileSet.has(p)).length;

  // Emit issues from walker exclusions (LINK_OUTSIDE_PROJECT, LINK_TARGETS_DIRECTORY, etc.)
  rawIssues.push(...walkerExclusionsToIssues(excludedReferences, projectRoot));

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

  const excludedDetails = deduplicateExcludedReferences(excludedReferences, skillPath);

  // Run quality / best-practice checks
  collectSizeIssues(skillLines, totalLines, fileCount, maxLinkDepth, skillPath, rawIssues);
  collectDescriptionIssue(parseResult.frontmatter, skillPath, rawIssues);
  collectProgressiveDisclosureIssue(skillLines, bundledFiles.length, skillPath, rawIssues);

  // Filter out source-only codes when validating built output
  const filteredIssues = context === 'built'
    ? rawIssues.filter(issue => !SOURCE_ONLY_CODES.has(issue.code))
    : rawIssues;

  // Run through the unified validation framework
  const validationConfig = packagingConfig?.validation ?? {};
  const framework = runValidationFramework(filteredIssues, validationConfig);

  const skillName = extractSkillName(parseResult, skillPath);

  const activeErrors = framework.emitted.filter(i => i.severity === 'error');
  const activeWarnings = framework.emitted.filter(i => i.severity === 'warning');

  return {
    skillName,
    status: framework.hasErrors ? 'error' : 'success',
    allErrors: framework.emitted,
    activeErrors,
    activeWarnings,
    ignoredErrors: framework.allowed,
    metadata: {
      skillLines,
      totalLines,
      fileCount,
      directFileCount,
      maxLinkDepth,
      excludedReferenceCount: excludedDetails.length,
      excludedReferences: excludedDetails,
    },
  };
}

/**
 * Collect size and depth validation issues
 */
function collectSizeIssues(
  skillLines: number,
  totalLines: number,
  fileCount: number,
  maxLinkDepth: number,
  skillPath: string,
  issues: ValidationIssue[],
): void {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES) {
    const rule = VALIDATION_RULES.SKILL_LENGTH_EXCEEDS_RECOMMENDED;
    issues.push(createRegistryIssue(
      rule.code as IssueCode,
      rule.message({ lines: skillLines }),
      skillPath,
    ));
  }

  if (totalLines > VALIDATION_THRESHOLDS.MAX_TOTAL_LINES) {
    const rule = VALIDATION_RULES.SKILL_TOTAL_SIZE_LARGE;
    issues.push(createRegistryIssue(
      rule.code as IssueCode,
      rule.message({ totalLines }),
      skillPath,
    ));
  }

  if (fileCount > VALIDATION_THRESHOLDS.MAX_FILE_COUNT) {
    const rule = VALIDATION_RULES.SKILL_TOO_MANY_FILES;
    issues.push(createRegistryIssue(
      rule.code as IssueCode,
      rule.message({ fileCount }),
      skillPath,
    ));
  }

  if (maxLinkDepth > VALIDATION_THRESHOLDS.MAX_REFERENCE_DEPTH) {
    const rule = VALIDATION_RULES.REFERENCE_TOO_DEEP;
    issues.push(createRegistryIssue(
      rule.code as IssueCode,
      rule.message({ depth: maxLinkDepth }),
      skillPath,
    ));
  }
}

/**
 * Collect description quality issue (DESCRIPTION_TOO_VAGUE)
 */
function collectDescriptionIssue(
  frontmatter: Record<string, unknown> | undefined,
  skillPath: string,
  issues: ValidationIssue[],
): void {
  const description = frontmatter?.['description'];

  if (!description || typeof description !== 'string') {
    return; // Missing description is handled by existing validator
  }

  if (description.length < VALIDATION_THRESHOLDS.MIN_DESCRIPTION_LENGTH) {
    const rule = VALIDATION_RULES.DESCRIPTION_TOO_VAGUE;
    issues.push(createRegistryIssue(
      rule.code as IssueCode,
      rule.message({ length: description.length }),
      skillPath,
    ));
  }
}

/**
 * Collect progressive disclosure issue (NO_PROGRESSIVE_DISCLOSURE)
 */
function collectProgressiveDisclosureIssue(
  skillLines: number,
  referenceFileCount: number,
  skillPath: string,
  issues: ValidationIssue[],
): void {
  if (skillLines > VALIDATION_THRESHOLDS.RECOMMENDED_SKILL_LINES && referenceFileCount === 0) {
    const rule = VALIDATION_RULES.NO_PROGRESSIVE_DISCLOSURE;
    issues.push(createRegistryIssue(
      rule.code as IssueCode,
      rule.message({ lines: skillLines }),
      skillPath,
    ));
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
    const resolvedPath = safePath.resolve(dirname(markdownPath), hrefWithoutAnchor);

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
 * Reasons that are reported as validation errors instead of excluded references.
 * These are filtered out of the excluded references list.
 */
const VALIDATION_ERROR_REASONS: ReadonlySet<string> = new Set([EXCLUDE_REASON_DIRECTORY, EXCLUDE_REASON_OUTSIDE_PROJECT]);

/**
 * Deduplicate excluded references by path, preserving detail from first occurrence.
 * Filters out entries reported as validation errors (directory-target, outside-project).
 */
function deduplicateExcludedReferences(
  excludedReferences: LinkResolution[],
  skillPath: string,
): ExcludedReferenceDetail[] {
  const seenPaths = new Set<string>();
  const details: ExcludedReferenceDetail[] = [];

  for (const ref of excludedReferences) {
    if (VALIDATION_ERROR_REASONS.has(ref.excludeReason ?? '')) {
      continue;
    }
    if (seenPaths.has(ref.path)) {
      continue;
    }
    seenPaths.add(ref.path);
    const matchedPattern = ref.matchedRule?.patterns[0];
    const reason = mapExcludeReason(ref.excludeReason);
    details.push({
      path: toForwardSlash(safePath.relative(dirname(skillPath), ref.path)),
      reason,
      ...(matchedPattern === undefined ? {} : { matchedPattern }),
    });
  }

  return details;
}

/** Map walk-link-graph exclude reasons to detail reasons */
function mapExcludeReason(
  excludeReason: LinkResolution['excludeReason'],
): ExcludedReferenceDetail['reason'] {
  switch (excludeReason) {
    case 'pattern-matched': return 'pattern-matched';
    case 'navigation-file': return 'navigation-file';
    case 'skill-definition': return 'skill-definition';
    case 'gitignored': return 'gitignored';
    case 'depth-exceeded':
    case EXCLUDE_REASON_DIRECTORY:
    case EXCLUDE_REASON_OUTSIDE_PROJECT:
    case 'missing-target':
    case undefined:
    default:
      return DETAIL_REASON_DEPTH;
  }
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
