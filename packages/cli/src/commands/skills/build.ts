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
import { dirname } from 'node:path';


import {
  mergeFilesConfig,
  packageSkills,
  validateSkillForPackaging,
  type PackageSkillResult,
  type PackagingValidationResult,
  type SkillBuildSpec,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/agent-skills';
import type { SkillPackagingConfig as ConfigSkillPackagingConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { type createLogger } from '../../utils/logger.js';

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

/**
 * Sanitize skill names with colon namespaces for filesystem paths.
 *
 * Skill names use colon-namespacing (e.g. "vibe-agent-toolkit:resources") which is
 * valid in YAML/JSON but invalid as a directory name on Windows. Replace colons with
 * double-underscore -- unambiguous, reversible, and safe on all platforms.
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
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

Output:
  YAML summary -> stdout (for programmatic parsing)
  Build progress -> stderr (for human reading)

Exit Codes:
  0 - Build successful (or dry-run preview)
  1 - Validation error or build error
  2 - System error (missing config, invalid config)

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
      if (error.location) {
        logger.error(`       Location: ${String(error.location)}`);
      }
      if (error.fix) {
        logger.error(`       Fix: ${String(error.fix)}`);
      }
    }
  }
}

/**
 * Display expired acceptance warnings
 */
function displayExpiredAcceptances(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  const expiredWarnings = validationResult.activeWarnings.filter(w => w.code === 'ACCEPTANCE_EXPIRED');
  if (expiredWarnings.length > 0) {
    logger.error(`\n   Expired acceptances (${expiredWarnings.length}):`);
    for (const warn of expiredWarnings) {
      logger.error(`     ${String(warn.message)}`);
    }
  }
}

/**
 * Log post-build integrity issues (non-blocking) so users see them.
 *
 * These are best-practice checks run after packaging — the build itself succeeded.
 * We surface them at info level so they show up without failing the build.
 */
function logPostBuildIssues(
  result: PackageSkillResult,
  logger: ReturnType<typeof createLogger>,
): void {
  if (!result.postBuildIssues || result.postBuildIssues.length === 0) return;
  logger.info(`   ${result.postBuildIssues.length} post-build issue(s) (non-blocking):`);
  for (const issue of result.postBuildIssues) {
    logger.info(`     [${String(issue.code)}] ${String(issue.message)}`);
  }
}

/**
 * Display accepted issues for context
 */
function displayIgnoredErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.ignoredErrors.length > 0) {
    logger.info(`\n   Accepted issues (${validationResult.ignoredErrors.length}):`);
    for (const record of validationResult.ignoredErrors) {
      logger.info(`     [${String(record.code)}] ${String(record.location)} (accepted: ${record.reason})`);
    }
  }
}

/**
 * Merge packaging config: schema defaults -> config yaml defaults -> per-skill overrides.
 *
 * Uses shallow merge (spread) since all SkillPackagingConfig fields are top-level.
 * The excludeReferencesFromBundle and validation fields are objects,
 * but per-skill overrides should fully replace (not deep-merge) the defaults for those fields.
 */
function mergePackagingConfig(
  defaults: ConfigSkillPackagingConfig | undefined,
  perSkill: ConfigSkillPackagingConfig | undefined,
): SkillPackagingConfig {
  const merged = {
    ...defaults,
    ...perSkill,
  };

  // Strip undefined values to satisfy exactOptionalPropertyTypes.
  // Spread of optional Zod-inferred types can produce explicit `undefined` values
  // which are not assignable to optional-but-not-undefined properties.
  const result: SkillPackagingConfig = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  // Special merge for files: additive with per-skill dest override
  if (defaults?.files !== undefined || perSkill?.files !== undefined) {
    const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
    if (mergedFiles.length > 0) {
      (result as Record<string, unknown>)['files'] = mergedFiles;
    }
  }

  return result;
}

/**
 * Validate skill before building
 */
async function validateSkillOrExit(
  skillName: string,
  sourcePath: string,
  packagingConfig: SkillPackagingConfig,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  logger.debug(`   Validating skill: ${skillName}`);

  const validationResult = await validateSkillForPackaging(sourcePath, packagingConfig);

  if (validationResult.status !== 'error') {
    if (validationResult.ignoredErrors.length > 0) {
      logger.debug(`   ${validationResult.ignoredErrors.length} issue(s) accepted by config`);
    }
    return;
  }

  // Validation failed - display all errors and exit
  logger.error(`\nSkill validation failed: ${skillName}`);
  logger.error(`   Source: ${sourcePath}`);

  displayActiveErrors(validationResult, logger);
  displayExpiredAcceptances(validationResult, logger);
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
      const packagingConfig = mergePackagingConfig(
        skillsConfig.defaults,
        skillsConfig.config?.[skill.name],
      );

      const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skill.name));
      logger.info(`\nBuilding skill: ${skill.name}`);
      logger.info(`   Source: ${skill.sourcePath}`);
      logger.info(`   Output: ${outputDir}`);

      await validateSkillOrExit(skill.name, skill.sourcePath, packagingConfig, logger);
      validatedSpecs.push({ skill, packagingConfig });
    }

    // Build all skills with a shared registry
    const specs: SkillBuildSpec[] = validatedSpecs.map(({ skill, packagingConfig }) => ({
      skillPath: skill.sourcePath,
      options: {
        outputPath: safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skill.name)),
        formats: ['directory' as const],
        rewriteLinks: true,
        basePath: dirname(skill.sourcePath),
        ...(packagingConfig.resourceNaming && { resourceNaming: packagingConfig.resourceNaming }),
        ...(packagingConfig.stripPrefix && { stripPrefix: packagingConfig.stripPrefix }),
        ...(packagingConfig.linkFollowDepth !== undefined && { linkFollowDepth: packagingConfig.linkFollowDepth }),
        ...(packagingConfig.excludeReferencesFromBundle && { excludeReferencesFromBundle: packagingConfig.excludeReferencesFromBundle }),
        ...(packagingConfig.files && { files: packagingConfig.files }),
      },
    }));

    const packageResults = await packageSkills(specs, cwd);

    const results: Array<{ name: string; result: PackageSkillResult }> = [];
    for (const [i, spec] of validatedSpecs.entries()) {
      const result = packageResults[i];
      if (result) {
        logger.info(`   Built ${result.files.dependencies.length + 1} files`);
        logPostBuildIssues(result, logger);
        results.push({ name: spec.skill.name, result });
      }
    }

    const duration = Date.now() - startTime;

    // Output YAML results
    outputBuildYaml(results, duration);

    logger.info(`\nBuilt ${results.length} skill(s) successfully`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
