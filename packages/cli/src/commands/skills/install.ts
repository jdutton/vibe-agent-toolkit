/**
 * Install a skill to Claude's plugins directory
 *
 * Supports installing from:
 * - npm packages (npm:@scope/package)
 * - Local ZIP file
 * - Local directory
 * - npm postinstall hook (--npm-postinstall)
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { Command } from 'commander';

import { getClaudeUserPaths } from '../../utils/claude-paths.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

import {
  detectSource,
  downloadNpmPackage,
  isGlobalNpmInstall,
  readPackageJsonVatMetadata,
  type SkillSource,
} from './install-helpers.js';

export interface SkillsInstallCommandOptions {
  skillsDir?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  npmPostinstall?: boolean;
}

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install a skill to Claude Code skills directory')
    .argument('[source]', 'Source to install from (npm:package, ZIP file, or directory path)')
    .option(
      '-s, --skills-dir <path>',
      'Claude skills directory',
      getClaudeUserPaths().skillsDir
    )
    .option('-n, --name <name>', 'Custom name for installed skill (default: auto-detect from source)')
    .option('-f, --force', 'Overwrite existing skill if present', false)
    .option('--dry-run', 'Preview installation without creating files', false)
    .option('--npm-postinstall', 'Run as npm postinstall hook (internal use)', false)
    .option('--debug', 'Enable debug logging')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs a skill to Claude Code's skills directory from various sources.

  Supported sources:
  - npm package: npm:@scope/package-name
  - Local ZIP file: ./path/to/skill.zip
  - Local directory: ./path/to/skill-dir
  - npm postinstall: --npm-postinstall (automatic during global install)

  Default skills directory: ~/.claude/skills/

Output:
  - status: success/error
  - skillName: Name of installed skill
  - installPath: Where the skill was installed
  - source: Original source
  - sourceType: npm/local/zip/npm-postinstall

Exit Codes:
  0 - Installation successful
  1 - Installation error (invalid source, skill exists, etc.)
  2 - System error

Example:
  $ vat skills install npm:@vibe-agent-toolkit/vat-development-agents
  $ vat skills install ./cat-agents-skill.zip
  $ vat skills install ./my-skill-dir --name custom-skill-name
  $ vat skills install skill.zip --force
`
    );

  return command;
}

async function installCommand(
  source: string | undefined,
  options: SkillsInstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Handle --npm-postinstall flag
    if (options.npmPostinstall) {
      await handleNpmPostinstall(options, logger, startTime);
      return;
    }

    // Regular install - source is required
    if (!source) {
      throw new Error('Source argument required. Use npm:package, ./dir, or ./file.zip');
    }

    // Detect source type
    const sourceType = detectSource(source);
    logger.debug(`Detected source type: ${sourceType}`);

    // Route to appropriate handler
    switch (sourceType) {
      case 'npm': {
        await handleNpmInstall(source, options, logger, startTime);
        break;
      }
      case 'local': {
        await handleLocalInstall(source, options, logger, startTime);
        break;
      }
      case 'zip': {
        await handleZipInstall(source, options, logger, startTime);
        break;
      }
      case 'npm-postinstall': {
        // This case is handled by --npm-postinstall flag, not by source detection
        throw new Error('npm-postinstall source type should be handled by --npm-postinstall flag');
      }
    }
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsInstall');
  }
}

/**
 * Handle npm package installation
 */
async function handleNpmInstall(
  source: string,
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number
): Promise<void> {
  const packageName = source.startsWith('npm:') ? source.slice(4) : source;

  logger.info(`📥 Installing skill from npm: ${packageName}`);

  // Create temp directory
  const tempDir = await mkdtemp(join(normalizedTmpdir(), 'vat-install-npm-'));

  try {
    // Download and extract npm package
    logger.info('   Downloading package...');
    const extractedPath = downloadNpmPackage(packageName, tempDir);

    // Read vat metadata from package.json
    const { skills } = await readPackageJsonVatMetadata(extractedPath);

    if (skills.length === 0) {
      throw new Error(`No skills found in package ${packageName}`);
    }

    // Install first skill (or specific skill if --name provided)
    const skillToInstall = options.name
      ? skills.find(s => s.name === options.name)
      : skills[0];

    if (!skillToInstall) {
      throw new Error(
        `Skill "${options.name ?? ''}" not found in package ${packageName}. ` +
          `Available: ${skills.map(s => s.name).join(', ')}`
      );
    }

    // Determine skill path (from vat.skills metadata)
    const skillPath = resolve(extractedPath, skillToInstall.path);

    // Install skill
    await installSkillFromPath(
      skillPath,
      skillToInstall.name,
      options,
      logger
    );

    const duration = Date.now() - startTime;
    outputSuccess(
      skillToInstall.name,
      join(options.skillsDir ?? getClaudeUserPaths().skillsDir, skillToInstall.name),
      `npm:${packageName}`,
      'npm',
      duration,
      logger,
      options.dryRun
    );

    process.exit(0);
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Handle local directory installation
 */
async function handleLocalInstall(
  source: string,
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number
): Promise<void> {
  const sourcePath = resolve(source);

  logger.info(`📥 Installing skill from directory: ${sourcePath}`);

  // Check if directory contains package.json with vat.skills
  const packageJsonPath = join(sourcePath, 'package.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  const hasPackageJson = existsSync(packageJsonPath);

  let skillName: string;
  let skillPath: string;

  if (hasPackageJson) {
    // Read vat metadata
    const { skills } = await readPackageJsonVatMetadata(sourcePath);

    const skillToInstall = options.name
      ? skills.find(s => s.name === options.name)
      : skills[0];

    if (!skillToInstall) {
      throw new Error(
        `Skill "${options.name ?? ''}" not found in package. ` +
          `Available: ${skills.map(s => s.name).join(', ')}`
      );
    }

    skillName = skillToInstall.name;
    skillPath = resolve(sourcePath, skillToInstall.path);
  } else {
    // Plain directory - use directory name
    skillName = options.name ?? basename(sourcePath);
    skillPath = sourcePath;
  }

  await installSkillFromPath(
    skillPath,
    skillName,
    options,
    logger
  );

  const duration = Date.now() - startTime;
  outputSuccess(
    skillName,
    join(options.skillsDir ?? getClaudeUserPaths().skillsDir, skillName),
    `local:${sourcePath}`,
    'local',
    duration,
    logger,
    options.dryRun
  );

  process.exit(0);
}

/**
 * Handle ZIP file installation
 */
async function handleZipInstall(
  source: string,
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number
): Promise<void> {
  const sourcePath = resolve(source);

  logger.info(`📥 Installing skill from ZIP: ${sourcePath}`);

  // Validate ZIP exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  if (!existsSync(sourcePath)) {
    throw new Error(`ZIP file not found: ${sourcePath}`);
  }

  const skillName = options.name ?? basename(sourcePath, '.zip');
  const { installPath } = await prepareInstallation(skillName, options);

  if (!options.dryRun) {
    // Extract ZIP
    logger.info('   Extracting ZIP...');
    const zip = new AdmZip(sourcePath);
    // eslint-disable-next-line sonarjs/no-unsafe-unzip -- User-provided local files, isolated plugin directory
    zip.extractAllTo(installPath, /* overwrite */ true);
  }

  const duration = Date.now() - startTime;
  outputSuccess(skillName, installPath, sourcePath, 'zip', duration, logger, options.dryRun);

  process.exit(0);
}

/**
 * Handle npm postinstall hook
 */
async function handleNpmPostinstall(
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number
): Promise<void> {
  logger.info(`📥 Running npm postinstall hook`);

  // Check if this is a global install
  if (!isGlobalNpmInstall()) {
    logger.info('   Skipping: Not a global npm install');
    process.exit(0);
  }

  // Read package.json from current directory
  const cwd = process.cwd();
  const { packageJson, skills } = await readPackageJsonVatMetadata(cwd);

  logger.info(`   Package: ${packageJson.name}@${packageJson.version}`);
  logger.info(`   Skills found: ${skills.length}`);

  // Install all skills from package
  for (const skill of skills) {
    const skillPath = resolve(cwd, skill.path);
    await installSkillFromPath(
      skillPath,
      skill.name,
      options,
      logger
    );
  }

  const duration = Date.now() - startTime;
  logger.info(`✅ Installed ${skills.length} skill(s) from ${packageJson.name}`);
  logger.info(`   Duration: ${duration}ms`);

  process.exit(0);
}

/**
 * Prepare plugins directory and check for conflicts
 * Returns the install path for the skill
 */
async function prepareInstallation(
  skillName: string,
  options: SkillsInstallCommandOptions
): Promise<{ skillsDir: string; installPath: string }> {
  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;
  const installPath = join(skillsDir, skillName);

  // Check if skill already exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Constructed from validated paths
  if (existsSync(installPath) && !options.force) {
    throw new Error(
      `Skill already exists at ${installPath}. Use --force to overwrite.`
    );
  }

  if (!options.dryRun) {
    // Create plugins directory
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Plugins directory path, safe
    await mkdir(skillsDir, { recursive: true });
  }

  return { skillsDir, installPath };
}

/**
 * Install skill from a path to plugins directory
 */
async function installSkillFromPath(
  skillPath: string,
  skillName: string,
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path
  if (!existsSync(skillPath)) {
    throw new Error(`Skill path not found: ${skillPath}`);
  }

  const { installPath } = await prepareInstallation(skillName, options);

  if (!options.dryRun) {
    // Copy skill to plugins directory
    logger.info(`   Installing ${skillName}...`);
    await cp(skillPath, installPath, { recursive: true, force: true });
  }
}

/**
 * Output success YAML and human-readable messages
 */
function outputSuccess(
  skillName: string,
  installPath: string,
  source: string,
  sourceType: SkillSource,
  duration: number,
  logger: ReturnType<typeof createLogger>,
  dryRun?: boolean
): void {
  // Output YAML to stdout
  process.stdout.write('---\n');
  process.stdout.write(`status: success\n`);
  if (dryRun) {
    process.stdout.write(`dryRun: true\n`);
  }
  process.stdout.write(`skillName: ${skillName}\n`);
  process.stdout.write(`installPath: ${installPath}\n`);
  process.stdout.write(`source: ${source}\n`);
  process.stdout.write(`sourceType: ${sourceType}\n`);
  process.stdout.write(`duration: ${duration}ms\n`);

  if (dryRun) {
    logger.info(`✅ Dry-run complete (no files created)`);
    logger.info(`   Skill: ${skillName}`);
    logger.info(`   Would install to: ${installPath}`);
  } else {
    logger.info(`✅ Installed skill: ${skillName}`);
    logger.info(`   Location: ${installPath}`);
    logger.info(`\n💡 Run 'vat skills list' to verify installation`);
    logger.info(`   Restart Claude Code or run /reload-skills to use the new skill`);
  }
}
