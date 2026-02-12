/**
 * Build skills from source into dist/skills/ during package build
 *
 * Reads vat.skills from package.json and builds each skill using packageSkill()
 */

import { dirname, resolve } from 'node:path';

import type { VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';
import {
  packageSkills,
  validateSkillForPackaging,
  type PackageSkillResult,
  type PackagingValidationResult,
  type SkillBuildSpec,
} from '@vibe-agent-toolkit/agent-skills';
import { findProjectRoot } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { type createLogger } from '../../utils/logger.js';

import { filterSkillsByName, setupCommandContext, writeYamlHeader } from './command-helpers.js';
import { readPackageJson, validateSkillSource } from './shared.js';

export interface SkillsBuildCommandOptions {
  skill?: string;
  dryRun?: boolean;
  debug?: boolean;
}

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Build skills from source (reads vat.skills from package.json)')
    .argument('[path]', 'Path to directory with package.json (default: current directory)')
    .option('--skill <name>', 'Build specific skill only')
    .option('--dry-run', 'Preview build without creating files')
    .option('--debug', 'Enable debug logging')
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Builds all skills declared in package.json vat.skills field. For each
  skill, validates the skill for packaging (using validateSkillForPackaging),
  then runs packageSkill() and outputs to the configured path directory.

  Validation runs before packaging to catch errors early. Build fails if
  any active validation errors exist (after applying overrides).

  Typically run as part of package build: "build": "tsc && vat skills build"

Package.json Structure:
  {
    "vat": {
      "version": "1.0",
      "type": "agent-bundle",
      "skills": [
        {
          "name": "my-skill",
          "source": "./resources/skills/SKILL.md",
          "path": "./dist/skills/my-skill"
        }
      ]
    }
  }

Output:
  YAML summary → stdout (for programmatic parsing)
  Build progress → stderr (for human reading)

Exit Codes:
  0 - Build successful (or dry-run preview)
  1 - Validation error or build error
  2 - System error (missing package.json, invalid config)

Validation:
  Skills are validated before packaging using validateSkillForPackaging().
  Validation checks size, complexity, link depth, and navigation patterns.
  Supports overrides via ignoreValidationErrors in skill metadata.
  Build fails if active errors exist (after applying valid overrides).

Examples:
  $ vat skills build                    # Build all skills
  $ vat skills build --skill my-skill   # Build specific skill
  $ vat skills build --dry-run          # Preview without building
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
 * Display expired overrides
 */
function displayExpiredOverrides(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.expiredOverrides.length > 0) {
    logger.error(`\n   Expired overrides (${validationResult.expiredOverrides.length}):`);
    for (const { error, reason, expiredDate } of validationResult.expiredOverrides) {
      logger.error(`     [${String(error.code)}] ${String(error.message)}`);
      logger.error(`       Override expired: ${expiredDate} (reason: ${reason})`);
    }
  }
}

/**
 * Display ignored errors for context
 */
function displayIgnoredErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.ignoredErrors.length > 0) {
    logger.info(`\n   Ignored errors (${validationResult.ignoredErrors.length}):`);
    for (const { error, reason } of validationResult.ignoredErrors) {
      logger.info(`     [${String(error.code)}] ${String(error.message)} (ignored: ${reason})`);
    }
  }
}

/**
 * Validate skill before building
 */
async function validateSkillOrExit(
  skill: VatSkillMetadata,
  sourcePath: string,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  logger.debug(`   Validating skill: ${skill.name}`);

  const validationResult = await validateSkillForPackaging(sourcePath, skill);
  const hasActiveErrors =
    validationResult.activeErrors.length > 0 || validationResult.expiredOverrides.length > 0;

  if (!hasActiveErrors) {
    // Validation passed - log ignored errors if any
    if (validationResult.ignoredErrors.length > 0) {
      logger.debug(`   ℹ️  ${validationResult.ignoredErrors.length} error(s) ignored by overrides`);
    }
    return;
  }

  // Validation failed - display all errors and exit
  logger.error(`\n❌ Skill validation failed: ${skill.name}`);
  logger.error(`   Source: ${sourcePath}`);

  displayActiveErrors(validationResult, logger);
  displayExpiredOverrides(validationResult, logger);
  displayIgnoredErrors(validationResult, logger);

  logger.error(`\n   Build aborted due to validation errors`);
  process.exit(1);
}

/**
 * Output dry-run results
 */
function outputDryRunYaml(
  skills: VatSkillMetadata[],
  packageName: string,
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    dryRun: true,
    package: packageName,
    skillsFound: skills.length,
  });
  process.stdout.write(`skills:\n`);
  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    source: ${skill.source}\n`);
    process.stdout.write(`    path: ${skill.path}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

/**
 * Perform dry-run preview
 */
async function performDryRun(
  skillsToBuild: VatSkillMetadata[],
  packageName: string,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const startTime = Date.now();
  const cwd = process.cwd();

  logger.info(`🔍 Dry-run: Analyzing skill build...`);
  logger.info(`   Package: ${packageName}`);
  logger.info(`   Skills to build: ${skillsToBuild.length}`);

  // Validate all sources exist
  logger.info(`\n📋 Skills:`);
  for (const skill of skillsToBuild) {
    // Validate source exists (throws if missing)
    validateSkillSource(skill, cwd, logger);
    logger.info(`   ✅ ${skill.name}`);
    logger.info(`      Source: ${skill.source} (exists)`);
    logger.info(`      Output: ${skill.path}`);
  }

  const duration = Date.now() - startTime;

  // Output YAML results
  outputDryRunYaml(skillsToBuild, packageName, duration);

  logger.info(`\n✅ Dry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to build the skills`);
}

/**
 * Output build results
 */
function outputBuildYaml(
  results: Array<{ skill: VatSkillMetadata; result: PackageSkillResult }>,
  packageName: string,
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    package: packageName,
    skillsBuilt: results.length,
  });
  process.stdout.write(`skills:\n`);
  for (const { skill, result } of results) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    outputPath: ${result.outputPath}\n`);
    process.stdout.write(`    filesPackaged: ${result.files.dependencies.length + 1}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

async function buildCommand(
  pathArg: string | undefined,
  options: SkillsBuildCommandOptions
): Promise<void> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // Read package.json
    const packageJson = await readPackageJson(cwd);
    const skills = packageJson.vat?.skills ?? [];

    if (skills.length === 0) {
      throw new Error('No skills found in package.json vat.skills');
    }

    // Filter by skill name if specified
    const skillsToBuild = filterSkillsByName(skills, options.skill);

    logger.info(`📦 Found ${skillsToBuild.length} skill(s) to build`);

    // Ensure package has a name
    const packageName = packageJson.name ?? 'unnamed-package';

    // Handle dry-run mode
    if (options.dryRun) {
      await performDryRun(skillsToBuild, packageName, logger);
      process.exit(0);
    }

    // Validate all skills before building
    const validatedSpecs: Array<{ skill: VatSkillMetadata; sourcePath: string }> = [];
    for (const skill of skillsToBuild) {
      const sourcePath = validateSkillSource(skill, cwd, logger);
      logger.info(`\n📦 Building skill: ${skill.name}`);
      logger.info(`   Source: ${skill.source}`);
      logger.info(`   Output: ${skill.path}`);
      await validateSkillOrExit(skill, sourcePath, logger);
      validatedSpecs.push({ skill, sourcePath });
    }

    // Build all skills with a shared registry
    const projectRoot = findProjectRoot(cwd);
    const specs: SkillBuildSpec[] = validatedSpecs.map(({ skill, sourcePath }) => ({
      skillPath: sourcePath,
      options: {
        outputPath: resolve(cwd, skill.path),
        formats: ['directory' as const],
        rewriteLinks: true,
        basePath: dirname(sourcePath),
        ...(skill.packagingOptions?.resourceNaming && { resourceNaming: skill.packagingOptions.resourceNaming }),
        ...(skill.packagingOptions?.stripPrefix && { stripPrefix: skill.packagingOptions.stripPrefix }),
        ...(skill.packagingOptions?.linkFollowDepth !== undefined && { linkFollowDepth: skill.packagingOptions.linkFollowDepth }),
        ...(skill.packagingOptions?.excludeReferencesFromBundle && { excludeReferencesFromBundle: skill.packagingOptions.excludeReferencesFromBundle }),
      },
    }));

    const packageResults = await packageSkills(specs, projectRoot);

    const results: Array<{ skill: VatSkillMetadata; result: PackageSkillResult }> = [];
    for (const [i, spec] of validatedSpecs.entries()) {
      const result = packageResults[i];
      if (result) {
        logger.info(`   ✅ Built ${result.files.dependencies.length + 1} files`);
        results.push({ skill: spec.skill, result });
      }
    }

    const duration = Date.now() - startTime;

    // Output YAML results
    outputBuildYaml(results, packageName, duration);

    logger.info(`\n✅ Built ${results.length} skill(s) successfully`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
