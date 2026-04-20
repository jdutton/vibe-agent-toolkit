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
import { findProjectRoot, normalizedTmpdir, toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';

import type { EvidenceRecord, Observation } from '../evidence/index.js';
import { walkLinkGraph, type LinkResolution, type WalkableRegistry } from '../walk-link-graph.js';

import type { AllowRecord } from './allow-filter.js';
import { CODE_REGISTRY, type IssueCode } from './code-registry.js';
import { observationToIssue, runCompatDetectors } from './compat-detectors.js';
import { detectUndeclaredCrossSkillAuth } from './cross-skill-dependency-detection.js';
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
  /**
   * Declared runtime targets for this skill. Used by the CLI verdict layer
   * to suppress non-applicable compat verdicts. The packaging validator
   * itself only stores the declaration; verdict computation lives in the
   * CLI (which can also bring in plugin / marketplace target layers).
   */
  targets?: ReadonlyArray<'claude-chat' | 'claude-cowork' | 'claude-code'>;
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

  /**
   * Capability observations rolled up from compat detectors.
   * Carried alongside emitted issues so downstream verdict computation
   * (CLI layer) can recover observation payloads (e.g. EXTERNAL_CLI binary)
   * without re-parsing the skill.
   */
  observations: Observation[];

  /**
   * Raw evidence records collected by compat detectors. Surfaced so that
   * audit `--verbose` can render the underlying matches for each capability
   * observation without re-parsing the skill.
   */
  evidence: EvidenceRecord[];

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

  // Compat capability detection: collect observations from SKILL.md and
  // surface each as a CAPABILITY_* issue. Observations are also returned
  // on the result so downstream verdict computation (CLI layer) can recover
  // payloads such as EXTERNAL_CLI binary names.
  const { evidence, observations } = runCompatDetectors(skillContent, skillPath);
  for (const obs of observations) {
    rawIssues.push(observationToIssue(obs, skillPath));
  }

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
  collectNameMismatchIssue(parseResult.frontmatter, skillPath, rawIssues);
  collectTimeSensitiveContentIssues(parseResult.content, skillPath, rawIssues);

  // Cross-skill dependency smell: body declares a requires/depends token the
  // description does not mention. Uses the post-frontmatter content slice.
  if (parseResult.frontmatter) {
    rawIssues.push(...detectUndeclaredCrossSkillAuth(parseResult.frontmatter, parseResult.content));
  }

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
    observations,
    evidence,
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
 * Kebab-case pattern used by the Agent Skill schema for `name`. The check
 * only fires when the parent directory itself looks like a skill directory
 * (same kebab-case shape). This avoids false positives when SKILL.md lives
 * at a repo root or inside an unrelated container.
 */
const SKILL_DIR_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Generic container directory names that hold multiple skills in a flat layout.
 * When SKILL.md lives directly inside one of these, the parent dir name carries
 * no signal about what the skill is named — skip the mismatch check entirely.
 */
const GENERIC_CONTAINER_DIRS = new Set<string>(['skills', 'resources']);

/**
 * Detect SKILL_NAME_MISMATCHES_DIR issue from a frontmatter `name` and a
 * parent directory name. Returns null when no mismatch should be reported.
 *
 * Exported for direct unit testing — the packaging validator wires it up
 * with values derived from the skill path.
 */
export function detectNameMismatchIssue(
  frontmatterName: unknown,
  parentDir: string,
  skillPath: string,
): ValidationIssue | null {
  if (typeof frontmatterName !== 'string' || frontmatterName.trim() === '') {
    return null;
  }
  if (parentDir === '' || parentDir === '.' || parentDir === 'SKILL.md') {
    return null;
  }
  if (!SKILL_DIR_NAME_PATTERN.test(parentDir)) {
    return null;
  }
  if (GENERIC_CONTAINER_DIRS.has(parentDir.toLowerCase())) {
    return null;
  }

  const normalize = (s: string): string => s.trim().toLowerCase();
  if (normalize(frontmatterName) === normalize(parentDir)) {
    return null;
  }

  const registryEntry = CODE_REGISTRY.SKILL_NAME_MISMATCHES_DIR;
  return {
    severity: registryEntry.defaultSeverity,
    code: 'SKILL_NAME_MISMATCHES_DIR',
    message: `Frontmatter name "${frontmatterName}" does not match parent directory "${parentDir}"`,
    location: skillPath,
    fix: registryEntry.fix,
    reference: registryEntry.reference,
  };
}

/**
 * Collect SKILL_NAME_MISMATCHES_DIR issue. Skips when the skill lives in an
 * OS temp directory — unit tests and ad-hoc scratch runs don't have
 * meaningful parent-directory names.
 */
function collectNameMismatchIssue(
  frontmatter: Record<string, unknown> | undefined,
  skillPath: string,
  issues: ValidationIssue[],
): void {
  const resolvedSkillPath = toForwardSlash(safePath.resolve(skillPath));
  const resolvedTmpdir = toForwardSlash(safePath.resolve(normalizedTmpdir()));
  // eslint-disable-next-line local/no-path-startswith -- both operands are already toForwardSlash-normalized
  if (resolvedSkillPath.startsWith(`${resolvedTmpdir}/`)) {
    return;
  }

  const parentDir = basename(dirname(skillPath));
  const issue = detectNameMismatchIssue(frontmatter?.['name'], parentDir, skillPath);
  if (issue !== null) {
    issues.push(issue);
  }
}

/**
 * Time-sensitive content patterns. Case-insensitive.
 * Matches: "as of <month> YYYY", "after/before/until <month> YYYY",
 * and the year-first form "as of YYYY-MM".
 */
const MONTH_NAME_PATTERN = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
/* eslint-disable security/detect-non-literal-regexp -- compile-time constant patterns composed from MONTH_NAME_PATTERN, no user input */
const TIME_SENSITIVE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bas of ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  new RegExp(String.raw`\bafter ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  new RegExp(String.raw`\bbefore ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  new RegExp(String.raw`\buntil ${MONTH_NAME_PATTERN} \d{4}\b`, 'i'),
  /\bas of \d{4}-\d{2}\b/i,
];
/* eslint-enable security/detect-non-literal-regexp */

/**
 * Collect SKILL_TIME_SENSITIVE_CONTENT issues — scan the SKILL.md body for
 * time-sensitive prose that may become stale. One issue per distinct match
 * with line-number location.
 */
function collectTimeSensitiveContentIssues(
  content: string,
  skillPath: string,
  issues: ValidationIssue[],
): void {
  const registryEntry = CODE_REGISTRY.SKILL_TIME_SENSITIVE_CONTENT;
  const lines = content.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const pattern of TIME_SENSITIVE_PATTERNS) {
      const match = pattern.exec(line);
      if (match !== null) {
        const lineNumber = index + 1;
        issues.push({
          severity: registryEntry.defaultSeverity,
          code: 'SKILL_TIME_SENSITIVE_CONTENT',
          message: `Time-sensitive phrase "${match[0]}" may become stale`,
          location: `${skillPath}:${lineNumber}`,
          fix: registryEntry.fix,
          reference: registryEntry.reference,
        });
        // Only emit one issue per line (first match wins)
        break;
      }
    }
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
