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
  validateSkillForPackaging,
  type PackagingValidationResult,
  type SkillPackagingConfig,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import { gitFindRoot, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import * as yaml from 'js-yaml';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import { renderSkillQualityFooter } from '../../utils/skill-quality-footer.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';
import { discoverSkillsFromConfig } from '../skills/skill-discovery.js';

import {
  CHECKLIST_SECTIONS,
  MANUAL_CHECKLIST_ITEMS,
  sectionForCode,
  type ChecklistSection,
} from './review-checklist.js';

export interface SkillReviewCommandOptions {
  yaml?: boolean;
  debug?: boolean;
}

/**
 * Resolve the caller's argument to the absolute path of a SKILL.md file.
 *
 * Accepts either:
 * - a path to SKILL.md directly
 * - a directory that contains SKILL.md at its root
 *
 * Throws a user-friendly error for other inputs (missing path, arbitrary
 * markdown file, directory without SKILL.md).
 */
export function resolveSkillPath(pathArg: string): string {
  const absolute = safePath.resolve(pathArg);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-supplied path
  if (!existsSync(absolute)) {
    throw new Error(`Path does not exist: ${pathArg}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-supplied path
  const stat = statSync(absolute);

  if (stat.isFile()) {
    if (!absolute.endsWith('SKILL.md')) {
      throw new Error(
        `Expected a SKILL.md file or a skill directory containing SKILL.md. Got: ${pathArg}`,
      );
    }
    return absolute;
  }

  if (stat.isDirectory()) {
    const candidate = safePath.join(absolute, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidate constructed from validated dir
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
 * Build a SkillPackagingConfig for this skill by consulting the VAT config
 * at the git root (if any). Mirrors the lookup audit uses for single-skill
 * validation so review sees the same verdict-applicable config as validate
 * and audit.
 *
 * Returns `undefined` when the skill is not declared in any VAT config — in
 * which case the packaging validator uses its defaults.
 */
async function resolvePackagingConfig(
  skillPath: string,
  logger: Logger,
): Promise<SkillPackagingConfig | undefined> {
  const gitRoot = gitFindRoot(dirname(skillPath));
  const configRoot = gitRoot ?? dirname(skillPath);
  const config = loadConfig(configRoot);
  if (config?.skills === undefined) {
    return undefined;
  }

  try {
    const discovered = await discoverSkillsFromConfig(config.skills, configRoot);
    const match = discovered.find(
      s => safePath.resolve(s.sourcePath) === safePath.resolve(skillPath),
    );
    if (match === undefined) {
      return undefined;
    }

    const { defaults, config: perSkillConfig } = config.skills;
    return mergeSkillPackagingConfig(
      defaults as Record<string, unknown> | undefined,
      perSkillConfig?.[match.name] as Record<string, unknown> | undefined,
    );
  } catch (err) {
    logger.debug(`Config lookup failed for review: ${String(err)}`);
    return undefined;
  }
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
 * output goes to stdout via {@link outputYaml}.
 */
function renderHumanReport(
  result: PackagingValidationResult,
  skillPath: string,
  grouped: Map<ChecklistSection, ValidationIssue[]>,
  logger: Logger,
): void {
  const errorCount = result.activeErrors.length;
  const warningCount = result.activeWarnings.length;
  const infoCount = result.allErrors.filter(i => i.severity === 'info').length;

  logger.info('');
  logger.info(`Reviewing skill: ${result.skillName}`);
  logger.info(`Source: ${skillPath}`);
  logger.info(`Summary: ${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info`);
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
  if (issue.location !== undefined && issue.location !== '') {
    logger.info(`        Location: ${issue.location}`);
  }
  if (issue.fix !== undefined && issue.fix !== '') {
    logger.info(`        Fix: ${issue.fix}`);
  }
}

/**
 * Emit a machine-readable review payload to stdout as YAML. Used by --yaml
 * (e.g. CI consumption).
 */
function outputYaml(
  result: PackagingValidationResult,
  skillPath: string,
  grouped: Map<ChecklistSection, ValidationIssue[]>,
): void {
  const automated: Record<string, unknown[]> = {};
  for (const section of CHECKLIST_SECTIONS) {
    const issues = grouped.get(section) ?? [];
    if (issues.length === 0) continue;
    automated[section] = issues.map(i => ({
      code: i.code,
      severity: i.severity,
      message: i.message,
      ...(i.location === undefined ? {} : { location: i.location }),
      ...(i.fix === undefined ? {} : { fix: i.fix }),
    }));
  }

  const manual: Record<string, readonly string[]> = {};
  for (const section of CHECKLIST_SECTIONS) {
    const items = MANUAL_CHECKLIST_ITEMS[section];
    if (items.length > 0) {
      manual[section] = items;
    }
  }

  const errorCount = result.activeErrors.length;
  const warningCount = result.activeWarnings.length;

  const payload = {
    skill: result.skillName,
    source: skillPath,
    status: result.status,
    summary: {
      errors: errorCount,
      warnings: warningCount,
      info: result.allErrors.filter(i => i.severity === 'info').length,
    },
    metadata: result.metadata,
    automated,
    manual,
  };

  process.stdout.write('---\n');
  process.stdout.write(yaml.dump(payload, { indent: 2, lineWidth: 120, noRefs: true }));
}

/** Footer: share the checklist link when any skill-level finding fires. */
function renderFooter(result: PackagingValidationResult, logger: Logger): void {
  const emittedCodes = new Set<string>();
  for (const issue of result.allErrors) {
    emittedCodes.add(issue.code);
  }
  const hasSkillFindings =
    result.activeErrors.length > 0 || result.activeWarnings.length > 0;
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

    const skillPath = resolveSkillPath(pathArg);
    logger.debug(`Reviewing SKILL.md at: ${skillPath}`);

    const packagingConfig = await resolvePackagingConfig(skillPath, logger);
    const result = await validateSkillForPackaging(skillPath, packagingConfig);
    applyConfigVerdicts(
      result,
      packagingConfig?.targets as readonly Target[] | undefined,
      skillPath,
    );

    const grouped = groupIssuesBySection(result.allErrors);

    if (options.yaml) {
      outputYaml(result, skillPath, grouped);
    } else {
      renderHumanReport(result, skillPath, grouped, logger);
    }

    renderFooter(result, logger);

    const hasWarningsOrErrors =
      result.activeErrors.length > 0 || result.activeWarnings.length > 0;
    process.exit(hasWarningsOrErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillReview');
  }
}

export function createSkillReviewCommand(): Command {
  const command = new Command('review');

  command
    .description('Deep-review a single skill: automated findings plus a manual rubric walkthrough')
    .argument('<path>', 'Path to a SKILL.md file or a skill directory containing SKILL.md')
    .option('--yaml', 'Emit machine-readable YAML on stdout (for CI consumption)')
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

  Path: either a SKILL.md file or a directory containing SKILL.md at its root.
  Config: when run inside a VAT project, the matching skills.config entry is
  used automatically (same packaging options as 'vat skills build/validate').

  Output:
    Default: human-readable report to stderr (automated findings grouped by
             checklist section, then the manual walkthrough).
    --yaml:  structured YAML to stdout with automated + manual sections.

Exit Codes:
  0 - No errors and no warnings emitted
  1 - At least one error or warning present (errors and warnings treated equally — this is a review, not a gate)
  2 - System error (path missing, internal failure)

Example:
  $ vat skill review packages/my-agents/src/skills/ado/SKILL.md
`,
    );

  return command;
}
