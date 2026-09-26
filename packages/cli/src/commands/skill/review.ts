/**
 * `vat skill review <path>` — single-skill deep review
 *
 * Combines automated validation (via validateSkillForPackaging) with the
 * manual skill-quality checklist. Output is organized by checklist section:
 * each section shows automated findings that landed in it alongside the
 * judgment-call items a reviewer should walk through.
 *
 * This is a thin presentation layer. No new validation logic lives here —
 * the automated portion is the same code path used by `vat skills validate`.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  resolveAnchorRoot,
  validateSkillForPackaging,
  type PackagingValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import {
  buildReport,
  calculateValidationStatus,
  countBySeverity,
  exitCodeForReport,
  reportSchema,
  toFindings,
  type Report,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import { z } from 'zod';

import { resolveProjectDeclaredEvalSuites, resolveSkillPackagingConfig } from '../../skill-resolution/packaging-config.js';
import { handleReportCommandError } from '../../utils/command-error.js';
import { formatIssueAnchor } from '../../utils/issue-anchor.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';
import { renderSkillQualityFooter } from '../../utils/skill-quality-footer.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';

import {
  CHECKLIST_SECTIONS,
  MANUAL_CHECKLIST_ITEMS,
  sectionForCode,
  type ChecklistSection,
} from './review-checklist.js';

export interface SkillReviewCommandOptions {
  yaml?: boolean;
  /** Treat warnings as failing: end on `FINDINGS` when any warning is present. */
  strict?: boolean;
  debug?: boolean;
}

/** One checklist section: which automated findings landed in it, and what a reviewer walks through by hand. */
const ReviewSectionSchema = z.object({
  section: z.string(),
  /** Codes of the envelope's findings that belong to this section, in finding order. */
  codes: z.array(z.string()),
  /** The judgment-call items a reviewer completes for this section. */
  manual: z.array(z.string()),
}).strict();

/** What the review reports beyond its findings. */
export const SkillReviewDataSchema = z.object({
  skill: z.string(),
  /** The path the caller named. */
  source: z.string(),
  metadata: z.object({
    skillLines: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    directFileCount: z.number().int().nonnegative(),
    maxLinkDepth: z.number().int().nonnegative(),
    excludedReferenceCount: z.number().int().nonnegative(),
    excludedReferences: z.array(z.object({
      path: z.string(),
      reason: z.string(),
      matchedPattern: z.string().optional(),
    }).strict()),
  }).strict(),
  /**
   * Every checklist section, in rubric order — including the ones no finding
   * landed in, because the manual items are the point of a review and a
   * section with nothing automated still has to be walked through.
   */
  sections: z.array(ReviewSectionSchema),
}).strict();

export type SkillReviewData = z.infer<typeof SkillReviewDataSchema>;

/** The document `--yaml` publishes. */
export const SKILL_REVIEW_REPORT_SCHEMA = reportSchema(SkillReviewDataSchema);

export type SkillReviewReport = Report<SkillReviewData>;

/**
 * Resolve the caller's argument to the absolute path of a skill markdown file.
 *
 * Accepts:
 * - a path to a SKILL.md file directly
 * - a path to any single-file skill (.md)
 * - a directory that contains SKILL.md at its root
 *
 * Throws a user-friendly error for other inputs (missing path, non-.md file,
 * directory without SKILL.md). Frontmatter validity is not checked here —
 * the downstream packaging validator handles that.
 */
export function resolveSkillPath(pathArg: string): string {
  const absolute = safePath.resolve(pathArg);

  if (!existsSync(absolute)) {
    throw new Error(`Path does not exist: ${pathArg}`);
  }

  const stat = statSync(absolute);

  if (stat.isFile()) {
    if (!absolute.endsWith('.md')) {
      throw new Error(
        `Expected a markdown file (.md) or a skill directory. Got: ${pathArg}`,
      );
    }
    return absolute;
  }

  if (stat.isDirectory()) {
    const candidate = safePath.join(absolute, 'SKILL.md');
    if (!existsSync(candidate)) {
      throw new Error(
        `No SKILL.md found in directory: ${pathArg}. Point at the skill directory (containing SKILL.md) or the SKILL.md file directly.`,
      );
    }
    return candidate;
  }

  throw new Error(`Path is neither a file nor a directory: ${pathArg}`);
}

/**
 * Group all emitted issues by checklist section. Severity ordering inside a
 * section is: error > warning > info so the most severe finding is rendered
 * first.
 */
function groupIssuesBySection(
  issues: readonly ValidationIssue[],
): Map<ChecklistSection, ValidationIssue[]> {
  const grouped = new Map<ChecklistSection, ValidationIssue[]>();
  for (const section of CHECKLIST_SECTIONS) {
    grouped.set(section, []);
  }
  for (const issue of issues) {
    const section = sectionForCode(issue.code);
    grouped.get(section)?.push(issue);
  }

  const severityRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  for (const list of grouped.values()) {
    list.sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3));
  }
  return grouped;
}

/**
 * Render the human-readable review report to stderr (logger). Structured
 * output goes to stdout via {@link buildReviewReport}.
 */
function renderHumanReport(
  result: PackagingValidationResult,
  skillPath: string,
  grouped: Map<ChecklistSection, ValidationIssue[]>,
  logger: Logger,
): void {
  // One collapse, from schema: `allErrors` carries info issues despite the
  // name, and there is no `activeInfo` bucket to read them from.
  const counts = countBySeverity(result.allErrors);

  logger.info('');
  logger.info(`Reviewing skill: ${result.skillName}`);
  logger.info(`Source: ${skillPath}`);
  logger.info(
    `Summary: ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.info} info`,
  );
  logger.info(
    `Metadata: ${result.metadata.skillLines} SKILL.md lines, ${result.metadata.totalLines} total lines across ${result.metadata.fileCount} file(s)`,
  );

  logger.info('');
  logger.info('Automated findings (grouped by checklist section):');

  let hasAny = false;
  for (const section of CHECKLIST_SECTIONS) {
    const issues = grouped.get(section) ?? [];
    if (issues.length === 0) continue;
    hasAny = true;
    logger.info(`\n  ${section} (${issues.length}):`);
    for (const issue of issues) {
      renderIssue(issue, logger);
    }
  }
  if (!hasAny) {
    logger.info('  (none — every automated check passed)');
  }

  logger.info('');
  logger.info('Manual review checklist (judgment calls — walk through these):');
  for (const section of CHECKLIST_SECTIONS) {
    const items = MANUAL_CHECKLIST_ITEMS[section];
    if (items.length === 0) continue;
    logger.info(`\n  ${section}:`);
    for (const item of items) {
      logger.info(`    [ ] ${item}`);
    }
  }
}

/** Render a single validation issue in the human report. */
function renderIssue(issue: ValidationIssue, logger: Logger): void {
  const severityTag = issue.severity.toUpperCase();
  logger.info(`    - [${severityTag}] [${issue.code}] ${issue.message}`);
  const anchor = formatIssueAnchor(issue);
  if (anchor !== undefined) {
    logger.info(`        Location: ${anchor}`);
  }
  if (issue.fix !== undefined && issue.fix !== '') {
    logger.info(`        Fix: ${issue.fix}`);
  }
}

/**
 * The machine-readable review, for `--yaml` (e.g. CI consumption).
 *
 * `examined` is 1: a review looks at ONE skill, and the denominator says so
 * rather than leaving a reader to infer it from `skill`. Pure, so the shape is
 * unit-testable without a validator run.
 *
 * @param result - The validator's result
 * @param skillPath - The path the caller named
 * @param grouped - The findings by checklist section
 * @returns The report
 */
export function buildReviewReport(
  result: PackagingValidationResult,
  skillPath: string,
  grouped: ReadonlyMap<ChecklistSection, readonly ValidationIssue[]>,
): SkillReviewReport {
  const findings = CHECKLIST_SECTIONS.flatMap((section) => toFindings(grouped.get(section) ?? []));
  const sections = CHECKLIST_SECTIONS.map((section) => ({
    section,
    codes: toFindings(grouped.get(section) ?? []).map((issue) => issue.code),
    manual: [...MANUAL_CHECKLIST_ITEMS[section]],
  }));
  return buildReport<SkillReviewData>({
    examined: 1,
    findings,
    data: {
      skill: result.skillName,
      source: skillPath,
      metadata: {
        ...result.metadata,
        excludedReferences: result.metadata.excludedReferences.map((detail) => ({
          path: detail.path,
          reason: detail.reason,
          ...(detail.matchedPattern === undefined ? {} : { matchedPattern: detail.matchedPattern }),
        })),
      },
      sections,
    },
  });
}

/** Footer: share the checklist link when any skill-level finding fires. */
function renderFooter(result: PackagingValidationResult, logger: Logger): void {
  const emittedCodes = new Set<string>();
  for (const issue of result.allErrors) {
    emittedCodes.add(issue.code);
  }
  const hasSkillFindings = calculateValidationStatus(result.allErrors) !== 'success';
  renderSkillQualityFooter(logger, hasSkillFindings, emittedCodes);
}

export async function reviewCommand(
  pathArg: string | undefined,
  options: SkillReviewCommandOptions,
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    if (pathArg === undefined || pathArg === '') {
      throw new Error('Missing required argument: <path> (path to SKILL.md or a skill directory)');
    }

    // Spec §7: `vat skill review` uses `tolerate null` (single-skill review
    // operates with or without a governing project). Per-skill config now flows
    // through the shared resolveSkillPackagingConfig walk-up (the same one audit
    // uses), so review, audit, and skill test stay in lockstep.
    projectRootOrNull(process.cwd());

    const skillPath = resolveSkillPath(pathArg);
    logger.debug(`Reviewing SKILL.md at: ${skillPath}`);

    // `'refuse'` on both: a review that cannot tell whether this skill is
    // declared, or which suites are the project's, would report against the
    // wrong rules at exit 0. The throw lands in the catch below →
    // `handleReportCommandError`, exit 2.
    const packagingConfig = (await resolveSkillPackagingConfig(skillPath, 'refuse')) ?? undefined;
    // Project-wide test input: a review of skill A must not count skill B's eval
    // suite as content A ships. Memoized per config root; `[]` in wild mode.
    const result = await validateSkillForPackaging(skillPath, packagingConfig, 'source', {
      projectSkills: await resolveProjectDeclaredEvalSuites(skillPath, 'refuse'),
      // Same ruling as the discovery above: a review is acted on whole, so a
      // directory the registry crawl cannot list refuses it by name.
      unreadable: 'refuse',
    });
    // The anchor root for a single-skill review is the skill's own project
    // boundary — the same base the packaging validator anchored its issues
    // against, so one report speaks one coordinate system.
    applyConfigVerdicts(
      result,
      packagingConfig?.targets as readonly Target[] | undefined,
      skillPath,
      resolveAnchorRoot(undefined, dirname(skillPath)),
    );

    const grouped = groupIssuesBySection(result.allErrors);

    const report = buildReviewReport(result, skillPath, grouped);
    if (options.yaml) {
      writeYamlOutput({ ...report, durationMs: Date.now() - startTime });
    } else {
      renderHumanReport(result, skillPath, grouped, logger);
    }

    renderFooter(result, logger);

    // Same counts the status channel is derived from, so the two agree by
    // construction. Errors fail; warnings fail only under `--strict` — this
    // used to exit 1 on a warning while every sibling exited 1 on errors only,
    // so the one verb meant for a human's review was the strictest gate.
    process.exit(exitCodeForReport(report, { strict: options.strict === true }));
  } catch (error) {
    handleReportCommandError(error, logger, startTime, 'SkillReview');
  }
}

export function createSkillReviewCommand(): Command {
  const command = new Command('review');

  command
    .description('Deep-review a single skill: automated findings plus a manual rubric walkthrough')
    .argument('<path>', 'Path to a SKILL.md file, a single-file skill (.md), or a skill directory containing SKILL.md')
    .option('--yaml', 'Emit machine-readable YAML on stdout (for CI consumption)')
    .option('--strict', 'Exit 1 on warnings as well as errors')
    .option('--debug', 'Enable debug logging')
    .action(reviewCommand)
    .addHelpText(
      'after',
      `
Description:
  Runs the same validation as 'vat skills validate' against a single skill,
  then groups the findings by the section of the skill-quality checklist
  they belong to, and prints the judgment-call items from that checklist
  as a walk-through rubric for a reviewer to complete.

  Path: a SKILL.md file, any single-file skill (.md), or a directory containing SKILL.md at its root.
  Config: when run inside a VAT project, the matching skills.config entry is
  used automatically (same packaging options as 'vat skills build/validate').

  Output:
    Default: human-readable report to stderr (automated findings grouped by
             checklist section, then the manual walkthrough).
    --yaml:  the report envelope as YAML on stdout — status (ok | findings),
             examined (always 1), findings, summary {errors, warnings, info},
             and data.sections: every checklist section with the codes of
             the findings that landed in it and its manual items. The exit
             code is derived from the same summary: exit 1 iff
             summary.errors + summary.warnings > 0.

Exit Codes:
  0 - No error-severity finding (warnings and info are in the report; --strict promotes warnings)
  1 - At least one error present, or any warning under --strict
  2 - System error (path missing, internal failure)

Requirements:
  projectRoot: optional (tolerates absence)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat skill review packages/my-agents/src/skills/ado/SKILL.md
`,
    );

  return command;
}
