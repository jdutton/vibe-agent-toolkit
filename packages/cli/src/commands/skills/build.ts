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

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { formatIssueAnchor } from '../../utils/issue-anchor.js';
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
 * Display active validation errors
 */
function displayActiveErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.activeErrors.length > 0) {
    logger.error(`\n   Active errors (${validationResult.activeErrors.length}):`);
    for (const error of validationResult.activeErrors) {
      logger.error(`     [${String(error.code)}] ${String(error.message)}`);
      const anchor = formatIssueAnchor(error);
      if (anchor !== undefined) {
        logger.error(`       Location: ${anchor}`);
      }
      if (error.fix) {
        logger.error(`       Fix: ${String(error.fix)}`);
      }
    }
  }
}

/**
 * Display expired allow warnings
 */
function displayExpiredAllowEntries(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  const expiredWarnings = validationResult.activeWarnings.filter(w => w.code === 'ALLOW_EXPIRED');
  if (expiredWarnings.length > 0) {
    logger.error(`\n   Expired allow entries (${expiredWarnings.length}):`);
    for (const warn of expiredWarnings) {
      logger.error(`     ${String(warn.message)}`);
    }
  }
}

/**
 * Log post-build integrity issues, prefixed by resolved severity.
 *
 * Errors are emitted to stderr; warnings and info to stderr as well so they
 * appear in the human-readable stream (not the YAML stdout stream).
 */
function logPostBuildIssues(
  result: PackageSkillResult,
  logger: ReturnType<typeof createLogger>,
): void {
  if (!result.postBuildIssues || result.postBuildIssues.length === 0) return;
  const label = result.hasErrors ? 'post-build error(s)' : 'post-build warning(s)';
  logger.info(`   ${result.postBuildIssues.length} ${label}:`);
  for (const issue of result.postBuildIssues) {
    const prefix = issue.severity === 'error' ? 'ERROR' : 'WARNING';
    logger.info(`     [${prefix}] [${String(issue.code)}] ${String(issue.message)}`);
    const anchor = formatIssueAnchor(issue);
    if (anchor !== undefined) {
      logger.info(`       Location: ${anchor}`);
    }
    if (issue.fix) {
      logger.info(`       Fix: ${String(issue.fix)}`);
    }
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
  locationRoot: string
): Promise<void> {
  logger.debug(`   Validating skill: ${skillName}`);

  const validationResult = await validateSkillForPackaging(sourcePath, packagingConfig);
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

  // Validation failed - display all errors and exit
  logger.error(`\nSkill validation failed: ${skillName}`);
  logger.error(`   Source: ${sourcePath}`);

  displayActiveErrors(validationResult, logger);
  displayExpiredAllowEntries(validationResult, logger);
  displayIgnoredErrors(validationResult, logger);

  logger.error(`\n   Build aborted due to validation errors`);
  process.exit(1);
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
 * Output build results
 */
function outputBuildYaml(
  results: Array<{ name: string; result: PackageSkillResult }>,
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    skillsBuilt: results.length,
  });
  process.stdout.write(`skills:\n`);
  for (const { name, result } of results) {
    process.stdout.write(`  - name: ${name}\n`);
    process.stdout.write(`    outputPath: ${result.outputPath}\n`);
    process.stdout.write(`    filesPackaged: ${result.files.dependencies.length + 1}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
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

    // Validate all skills before building
    const validatedSpecs: Array<{
      skill: DiscoveredSkill;
      packagingConfig: SkillPackagingConfig;
    }> = [];

    for (const skill of skillsToBuild) {
      const packagingConfig = mergeSkillPackagingConfig(
        skillsConfig.defaults,
        skillsConfig.config?.[skill.name],
      );

      const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skill.name));
      logger.info(`\nBuilding skill: ${skill.name}`);
      logger.info(`   Source: ${skill.sourcePath}`);
      logger.info(`   Output: ${outputDir}`);

      await validateSkillOrExit(skill.name, skill.sourcePath, packagingConfig, logger, cwd);
      validatedSpecs.push({ skill, packagingConfig });
    }

    // Build all skills with a shared registry
    const specs: SkillBuildSpec[] = validatedSpecs.map(({ skill, packagingConfig }) => ({
      skillPath: skill.sourcePath,
      options: packagingConfigToPackageOptions(packagingConfig, {
        skillPath: skill.sourcePath,
        outputPath: safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skill.name)),
      }),
    }));

    const packageResults = await packageSkills(specs, cwd);

    const results: Array<{ name: string; result: PackageSkillResult }> = [];
    const skillsWithErrors: string[] = [];
    for (const [i, spec] of validatedSpecs.entries()) {
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

    const duration = Date.now() - startTime;

    // Output YAML results
    outputBuildYaml(results, duration);

    if (skillsWithErrors.length > 0) {
      logger.error(`\nBuild failed: ${skillsWithErrors.length} skill(s) emitted post-build validation errors`);
      for (const name of skillsWithErrors) {
        logger.error(`   - ${name}`);
      }
      process.exit(1);
    }

    logger.info(`\nBuilt ${results.length} skill(s) successfully`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
