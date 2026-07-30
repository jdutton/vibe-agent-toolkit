/**
 * Build skills from source into dist/skills/ during package build
 *
 * Reads skills config from vibe-agent-toolkit.config.yaml, discovers SKILL.md
 * files via include/exclude globs, reads frontmatter for skill names, merges
 * packaging config (schema defaults -> config defaults -> per-skill overrides),
 * validates, and packages into dist/skills/<name>/.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import {
  allowUnusedIssues,
  calculateValidationStatus,
  countBySeverity,
  createAllowUsageLedger,
  type AllowUsageLedger,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
import {
  packageSkills,
  packagingConfigToPackageOptions,
  skillNameToFsPath,
  validateSkillForPackaging,
  type PackageSkillResult,
  type PackagingValidationResult,
  type SkillBuildSpec,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import * as yaml from 'yaml';

import { handleCommandError, handleValidationGateFailure } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import {
  collectPostBuildIssues,
  formatIssueLines,
  formatIssueSetHeading,
  formatRunIssueLines,
  sumSeverityCounts,
} from '../../utils/issue-rendering.js';
import { type createLogger } from '../../utils/logger.js';
import { requireProjectRoot } from '../../utils/project-root-policy.js';
import { mergeSkillPackagingConfig } from '../../utils/skill-packaging-config.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';

import {
  filterSkillsByName,
  setupCommandContext,
  writeYamlHeader,
  type DiscoveredSkill,
} from './command-helpers.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';

export interface SkillsBuildCommandOptions {
  skill?: string;
  dryRun?: boolean;
  debug?: boolean;
}

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Build skills from config yaml (discovers SKILL.md files via globs)')
    .argument('[path]', 'Path to project directory (default: current directory)')
    .option('--skill <name>', 'Build specific skill only')
    .option('--dry-run', 'Preview build without creating files')
    .option('--debug', 'Enable debug logging')
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Discovers SKILL.md files using include/exclude globs from the skills
  section of vibe-agent-toolkit.config.yaml. Reads each SKILL.md's
  frontmatter to extract the skill name, merges packaging config
  (schema defaults -> config yaml defaults -> per-skill overrides),
  validates, and packages into dist/skills/<name>/.

Config Structure (vibe-agent-toolkit.config.yaml):
  version: 1
  skills:
    include: ["resources/skills/**/SKILL.md"]
    exclude: ["resources/skills/draft/**"]
    defaults:
      linkFollowDepth: 2
      resourceNaming: basename
    config:
      my-skill:
        linkFollowDepth: full
        validation:
          severity:
            LINK_TO_NAVIGATION_FILE: ignore
          allow:
            LINK_DROPPED_BY_DEPTH:
              - paths: ["docs/**"]
                reason: depth drop is intentional for large reference docs

Validation:
  Both pre-build and post-build checks use the unified validation framework.
  Override per-code severity (error/warning/ignore) or allow specific paths
  via validation.severity and validation.allow in vibe-agent-toolkit.config.yaml.
  See docs/validation-codes.md for all codes and their defaults.

Output:
  YAML summary -> stdout (for programmatic parsing)
  Build progress -> stderr (for human reading)

Exit Codes:
  0 - All skills built successfully (or dry-run preview)
  1 - One or more skills emitted validation errors
  2 - System error (config invalid, directory not found)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file with skills.* fields populated

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat skills build                    # Build all skills from config
`
    );

  return command;
}

/**
 * Render every emitted pre-build finding, each labelled with its own severity.
 *
 * `allErrors` is the full emitted set INCLUDING info (its name lies — see the
 * doc comment on `PackagingValidationResult`). Walking only the errors plus the
 * `ALLOW_EXPIRED` subset of the warnings, which is what this used to do,
 * dropped every other warning and every info finding from a report that had
 * already decided to abort the build.
 *
 * Pure so the whole set is assertable, not a chosen subset of it.
 */
export function formatPreBuildIssueReport(
  validationResult: PackagingValidationResult,
): string[] {
  const lines: string[] = [];
  if (validationResult.allErrors.length > 0) {
    lines.push(`\n   ${formatIssueSetHeading(validationResult.allErrors)}:`);
    for (const issue of validationResult.allErrors) {
      lines.push(...formatIssueLines(issue, '     '));
    }
  }
  return lines;
}

/**
 * Render post-build integrity issues, each prefixed by its OWN resolved severity.
 *
 * Reads BOTH post-build channels (see `collectPostBuildIssues`) so a build that
 * failed purely on the built-output validation still shows the findings that
 * failed it, and the heading names the set's actual severity mix rather than
 * calling every set by its worst member.
 *
 * Pure: returns the lines instead of writing them, so the whole rendered set is
 * assertable without capturing a stream.
 */
export function formatPostBuildIssueReport(result: PackageSkillResult): string[] {
  const issues = collectPostBuildIssues(result);
  if (issues.length === 0) return [];
  const lines = [`   ${formatIssueSetHeading(issues, 'post-build')}:`];
  for (const issue of issues) {
    lines.push(...formatIssueLines(issue, '     '));
  }
  return lines;
}

/**
 * Log post-build integrity issues to stderr (the human stream; stdout is
 * reserved for the YAML summary).
 */
function logPostBuildIssues(
  result: PackageSkillResult,
  logger: ReturnType<typeof createLogger>,
): void {
  for (const line of formatPostBuildIssueReport(result)) {
    logger.info(line);
  }
}

/**
 * Display allowed issues for context
 */
function displayIgnoredErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.ignoredErrors.length > 0) {
    logger.info(`\n   Allowed issues (${validationResult.ignoredErrors.length}):`);
    for (const record of validationResult.ignoredErrors) {
      logger.info(`     [${String(record.code)}] ${String(record.location)} (allowed: ${record.reason})`);
    }
  }
}

/**
 * Validate skill before building
 */
async function validateSkillOrExit(
  skillName: string,
  sourcePath: string,
  packagingConfig: SkillPackagingConfig,
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
  allowLedger: AllowUsageLedger,
): Promise<void> {
  logger.debug(`   Validating skill: ${skillName}`);

  // The run's ledger, not this call's: an allow entry scoped to a SOURCE
  // filename can only ever match here — packaging renames the file to
  // `SKILL.md` and the built lane drops the source-only codes — so a build that
  // withholds this lane's matches from the run reports live entries as dead.
  const validationResult = await validateSkillForPackaging(
    sourcePath,
    packagingConfig,
    'source',
    { allowLedger },
  );
  applyConfigVerdicts(
    validationResult,
    packagingConfig.targets as readonly Target[] | undefined,
    sourcePath,
    locationRoot,
  );

  if (validationResult.status !== 'error') {
    if (validationResult.ignoredErrors.length > 0) {
      logger.debug(`   ${validationResult.ignoredErrors.length} issue(s) allowed by config`);
    }
    return;
  }

  // Validation failed - display every emitted finding and exit
  logger.error(`\nSkill validation failed: ${skillName}`);
  logger.error(`   Source: ${sourcePath}`);

  for (const line of formatPreBuildIssueReport(validationResult)) {
    logger.error(line);
  }
  displayIgnoredErrors(validationResult, logger);

  logger.error(`\n   Build aborted due to validation errors`);
  // Every finding above went to STDERR. Exiting here without the stdout summary
  // is what made `vat skills build | jq .status` return an empty document
  // alongside exit 1 — the one case the help text documents exit 1 for.
  handleValidationGateFailure(skillName, validationResult.allErrors);
}

/**
 * Output dry-run results
 */
function outputDryRunYaml(
  skills: DiscoveredSkill[],
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    dryRun: true,
    // A dry run validates NOTHING, so it has no severity distribution to
    // publish. Saying so is the point: an absent `issueCounts` next to
    // `status: success` otherwise reads as "clean", which is the reassuring
    // misreading. This field makes the absence explicit instead.
    validated: false,
    skillsFound: skills.length,
  });
  process.stdout.write(`skills:\n`);
  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    source: ${skill.sourcePath}\n`);
    process.stdout.write(`    output: dist/skills/${skillNameToFsPath(skill.name)}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

/**
 * Perform dry-run preview
 */
function performDryRun(
  skillsToBuild: DiscoveredSkill[],
  duration: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Dry-run: Analyzing skill build...`);
  logger.info(`   Skills to build: ${skillsToBuild.length}`);

  logger.info(`\nSkills:`);
  for (const skill of skillsToBuild) {
    logger.info(`   ${skill.name}`);
    logger.info(`      Source: ${skill.sourcePath}`);
    logger.info(`      Output: dist/skills/${skillNameToFsPath(skill.name)}`);
  }

  outputDryRunYaml(skillsToBuild, duration);

  logger.info(`\nDry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to build the skills`);
}

/**
 * The archived summary of a build, as YAML fields.
 *
 * `status` used to be the literal `success` — printed even for a build that then
 * exited 1 on post-build errors, so the machine-readable half of the output
 * contradicted the exit code, in the reassuring direction. It is now derived
 * from the same issues the human stream renders, and the per-severity counts
 * ride beside it because a status cannot express a three-valued distribution:
 * `success` here means "nothing you must act on", not "there was nothing to see".
 */
export function buildYamlSummary(
  results: Array<{ name: string; result: PackageSkillResult }>,
  duration: number,
  runIssues: readonly ValidationIssue[],
): {
  status: 'success' | 'warning' | 'error';
  issueCounts: SeverityCounts;
  runIssueCounts: SeverityCounts;
  skillsBuilt: number;
  skills: Array<{
    name: string;
    outputPath: string;
    filesPackaged: number;
    issueCounts: SeverityCounts;
  }>;
  runIssues: ValidationIssue[];
  duration: string;
} {
  const perSkill = results.map(({ name, result }) => {
    const issues = collectPostBuildIssues(result);
    return {
      name,
      outputPath: result.outputPath,
      filesPackaged: result.files.dependencies.length + 1,
      issueCounts: countBySeverity(issues),
      issues,
    };
  });
  const allIssues = perSkill.flatMap((s) => s.issues);
  const runIssueCounts = countBySeverity(runIssues);

  return {
    status: calculateValidationStatus([...allIssues, ...runIssues]),
    issueCounts: sumSeverityCounts([...perSkill.map((s) => s.issueCounts), runIssueCounts]),
    runIssueCounts,
    skillsBuilt: results.length,
    skills: perSkill.map(({ name, outputPath, filesPackaged, issueCounts }) => ({
      name,
      outputPath,
      filesPackaged,
      issueCounts,
    })),
    runIssues: [...runIssues],
    duration: `${duration}ms`,
  };
}

/**
 * Output build results
 */
function outputBuildYaml(
  results: Array<{ name: string; result: PackageSkillResult }>,
  duration: number,
  runIssues: readonly ValidationIssue[],
): void {
  const summary = buildYamlSummary(results, duration, runIssues);
  const { status, skillsBuilt, issueCounts, runIssueCounts, skills, duration: durationText } = summary;
  writeYamlHeader({ status, skillsBuilt });
  process.stdout.write(
    yaml.stringify(
      { issueCounts, runIssueCounts, skills, runIssues: summary.runIssues },
      { indent: 2, lineWidth: 0, aliasDuplicateObjects: false },
    ),
  );
  process.stdout.write(`duration: ${durationText}\n`);
}

/**
 * Clean stale skill output directories before building.
 * Full build: clear entire dist/skills/. Single skill: clear just that skill's dir.
 */
async function cleanStaleSkillOutputs(cwd: string, skillName: string | undefined): Promise<void> {
  if (skillName) {
    const singleSkillDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from validated option
    if (existsSync(singleSkillDir)) {
      await rm(singleSkillDir, { recursive: true, force: true });
    }
  } else {
    const allSkillsDir = safePath.resolve(cwd, 'dist', 'skills');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from cwd
    if (existsSync(allSkillsDir)) {
      await rm(allSkillsDir, { recursive: true, force: true });
    }
  }
}

/** One discovered skill paired with the packaging config merged for it. */
export interface BuildSkillSpec {
  skill: DiscoveredSkill;
  packagingConfig: SkillPackagingConfig;
}

/** Everything one `vat build` invocation produced, ready to report on. */
export interface SkillBuildRun {
  results: Array<{ name: string; result: PackageSkillResult }>;
  /** Findings that belong to the run, not to any one skill (ALLOW_UNUSED). */
  runIssues: ValidationIssue[];
  /** Names of skills whose own post-build validation errored. */
  skillsWithErrors: string[];
}

/**
 * Validate, package, and drain — the whole span of ONE `vat build` invocation.
 *
 * The allow-usage ledger created here spans EVERY skill and BOTH validation
 * lanes (the source-tree pre-build check and the two lanes inside
 * `packageSkill`), because `validation.allow` is declared once for the package
 * while being evaluated once per skill per lane. Anything narrower reports
 * entries that legitimately matched somewhere else as unused: measured on this
 * repo's own 13-skill package, 3 live entries produced 32 false ALLOW_UNUSED
 * warnings — 6 from the cross-skill seam, 26 because the two lanes inside
 * `packageSkill` see a FILTERED issue population against a file packaging has
 * renamed to `SKILL.md`, so entries scoped to a source filename are structurally
 * incapable of matching there. A lane that sees a subset cannot answer "matched
 * nothing"; only the union can. Hence one ledger, drained once, here.
 *
 * Extracted from the command body so the span is testable without driving
 * `process.exit` — the drain seam is the thing worth asserting.
 */
export async function runSkillBuild(
  specs: readonly BuildSkillSpec[],
  cwd: string,
  logger: ReturnType<typeof createLogger>,
): Promise<SkillBuildRun> {
  const allowLedger = createAllowUsageLedger();

  // Validate all skills before building
  for (const { skill, packagingConfig } of specs) {
    const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skill.name));
    logger.info(`\nBuilding skill: ${skill.name}`);
    logger.info(`   Source: ${skill.sourcePath}`);
    logger.info(`   Output: ${outputDir}`);

    await validateSkillOrExit(skill.name, skill.sourcePath, packagingConfig, logger, cwd, allowLedger);
  }

  // Build all skills with a shared registry
  const buildSpecs: SkillBuildSpec[] = specs.map(({ skill, packagingConfig }) => ({
    skillPath: skill.sourcePath,
    options: packagingConfigToPackageOptions(packagingConfig, {
      skillPath: skill.sourcePath,
      outputPath: safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skill.name)),
    }),
  }));

  const packageResults = await packageSkills(buildSpecs, cwd, allowLedger);

  const results: Array<{ name: string; result: PackageSkillResult }> = [];
  const skillsWithErrors: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const result = packageResults[i];
    if (result) {
      logger.info(`   Built ${result.files.dependencies.length + 1} files`);
      logPostBuildIssues(result, logger);
      if (result.hasErrors) {
        skillsWithErrors.push(spec.skill.name);
      }
      results.push({ name: spec.skill.name, result });
    }
  }

  // Drain point: every skill and every lane has now contributed, so this is the
  // first place the run can honestly say an entry matched nothing.
  return { results, runIssues: allowUnusedIssues(allowLedger), skillsWithErrors };
}

async function buildCommand(
  pathArg: string | undefined,
  options: SkillsBuildCommandOptions
): Promise<void> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // Spec §7: `vat skills build` requires a projectRoot — fails fast at the
    // CLI boundary if no config or git ancestor exists. The resolved root is
    // discarded here because config is read from `cwd` (the package dir),
    // not the project root; the guard exists to satisfy the policy contract.
    requireProjectRoot(cwd, 'vat skills build');

    // Load config yaml from cwd (not workspace root — config lives next to the package)
    const config = loadConfig(cwd);

    if (!config?.skills) {
      logger.info('No skills configuration found — nothing to build');
      process.exit(0);
    }

    const skillsConfig = config.skills;

    // Discover SKILL.md files from config globs (relative to cwd where config lives)
    logger.info(`Discovering skills from config...`);
    const discoveredSkills = await discoverSkillsFromConfig(skillsConfig, cwd);

    if (discoveredSkills.length === 0) {
      throw new Error(
        `No SKILL.md files found matching include patterns: ${skillsConfig.include.join(', ')}`
      );
    }

    // Filter by skill name if specified
    const skillsToBuild = filterSkillsByName(discoveredSkills, options.skill);

    logger.info(`Found ${skillsToBuild.length} skill(s) to build`);

    if (!options.dryRun) {
      await cleanStaleSkillOutputs(cwd, options.skill);
    }

    // Handle dry-run mode
    if (options.dryRun) {
      const duration = Date.now() - startTime;
      performDryRun(skillsToBuild, duration, logger);
      process.exit(0);
    }

    const buildSpecs: BuildSkillSpec[] = skillsToBuild.map((skill) => ({
      skill,
      packagingConfig: mergeSkillPackagingConfig(
        skillsConfig.defaults,
        skillsConfig.config?.[skill.name],
      ),
    }));

    const { results, runIssues, skillsWithErrors } = await runSkillBuild(buildSpecs, cwd, logger);

    const duration = Date.now() - startTime;

    // Output YAML results
    outputBuildYaml(results, duration, runIssues);
    for (const line of formatRunIssueLines(runIssues)) {
      logger.info(line);
    }

    if (skillsWithErrors.length > 0) {
      logger.error(`\nBuild failed: ${skillsWithErrors.length} skill(s) emitted post-build validation errors`);
      for (const name of skillsWithErrors) {
        logger.error(`   - ${name}`);
      }
    }
    // A run-level finding belongs to no skill, so the loop above cannot carry
    // it. Only `error` severity gates: ALLOW_UNUSED ships as a `warning`, and a
    // warning must never abort a build that produced its artifacts.
    const runHasErrors = runIssues.some((i) => i.severity === 'error');
    if (runHasErrors) {
      logger.error(`\nBuild failed: run-level validation errors (project config, not any one skill)`);
    }
    if (skillsWithErrors.length > 0 || runHasErrors) {
      process.exit(1);
    }

    logger.info(`\nBuilt ${results.length} skill(s) successfully`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
