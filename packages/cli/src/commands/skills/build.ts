/**
 * Build skills from source into dist/skills/ during package build
 *
 * Reads vat.skills from package.json and builds each skill using packageSkill()
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';
import { packageSkill, type PackageSkillResult } from '@vibe-agent-toolkit/agent-skills';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

import { filterSkillsByName, writeYamlHeader } from './command-helpers.js';

export interface SkillsBuildCommandOptions {
  skill?: string;
  dryRun?: boolean;
  debug?: boolean;
}

interface PackageJsonVat {
  skills?: VatSkillMetadata[];
}

interface PackageJson {
  name: string;
  vat?: PackageJsonVat;
}

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Build skills from source (reads vat.skills from package.json)')
    .option('--skill <name>', 'Build specific skill only')
    .option('--dry-run', 'Preview build without creating files')
    .option('--debug', 'Enable debug logging')
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Builds all skills declared in package.json vat.skills field. For each
  skill, validates the source exists, runs packageSkill(), and outputs to
  the configured path directory.

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
  1 - Invalid source or build error
  2 - System error (missing package.json, invalid config)

Examples:
  $ vat skills build                    # Build all skills
  $ vat skills build --skill my-skill   # Build specific skill
  $ vat skills build --dry-run          # Preview without building
`
    );

  return command;
}

/**
 * Read and parse package.json from current directory
 */
async function readPackageJson(cwd: string): Promise<PackageJson> {
  const packageJsonPath = join(cwd, 'package.json');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reading from validated current directory
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in current directory: ${cwd}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Reading from validated current directory
  const content = await readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(content) as PackageJson;

  if (!packageJson.vat?.skills || packageJson.vat.skills.length === 0) {
    throw new Error(
      'No skills found in package.json vat.skills field. Add skill metadata to build skills.'
    );
  }

  return packageJson;
}

/**
 * Validate skill source exists
 */
function validateSkillSource(
  skill: VatSkillMetadata,
  cwd: string,
  logger: ReturnType<typeof createLogger>
): string {
  const sourcePath = resolve(cwd, skill.source);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path resolved from package.json
  if (!existsSync(sourcePath)) {
    logger.error(`❌ Skill source not found: ${skill.source}`);
    logger.error(`   Expected path: ${sourcePath}`);
    process.exit(1);
  }

  return sourcePath;
}

/**
 * Build a single skill
 */
async function buildSkill(
  skill: VatSkillMetadata,
  sourcePath: string,
  cwd: string,
  logger: ReturnType<typeof createLogger>
): Promise<PackageSkillResult> {
  const outputPath = resolve(cwd, skill.path);
  const basePath = dirname(sourcePath);

  logger.info(`\n📦 Building skill: ${skill.name}`);
  logger.info(`   Source: ${skill.source}`);
  logger.info(`   Output: ${skill.path}`);

  const result = await packageSkill(sourcePath, {
    outputPath,
    formats: ['directory'],
    rewriteLinks: true,
    basePath,
  });

  logger.info(`   ✅ Built ${result.files.dependencies.length + 1} files`);

  return result;
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

async function buildCommand(options: SkillsBuildCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const cwd = process.cwd();

    logger.info(`📖 Reading package.json from ${cwd}`);

    // Read package.json
    const packageJson = await readPackageJson(cwd);
    const skills = packageJson.vat?.skills ?? [];

    if (skills.length === 0) {
      throw new Error('No skills found in package.json vat.skills');
    }

    // Filter by skill name if specified
    const skillsToBuild = filterSkillsByName(skills, options.skill);

    logger.info(`📦 Found ${skillsToBuild.length} skill(s) to build`);

    // Handle dry-run mode
    if (options.dryRun) {
      await performDryRun(skillsToBuild, packageJson.name, logger);
      process.exit(0);
    }

    // Build each skill
    const results: Array<{ skill: VatSkillMetadata; result: PackageSkillResult }> = [];

    for (const skill of skillsToBuild) {
      const sourcePath = validateSkillSource(skill, cwd, logger);
      const result = await buildSkill(skill, sourcePath, cwd, logger);
      results.push({ skill, result });
    }

    const duration = Date.now() - startTime;

    // Output YAML results
    outputBuildYaml(results, packageJson.name, duration);

    logger.info(`\n✅ Built ${results.length} skill(s) successfully`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
