/**
 * Install a skill to Claude's plugins directory
 *
 * Supports installing from:
 * - npm packages (npm:@scope/package)
 * - Local ZIP file
 * - Local directory
 * - npm postinstall hook (--npm-postinstall)
 */

import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { normalizedTmpdir, safeExecSync } from '@vibe-agent-toolkit/utils';
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
  writeYamlHeader,
} from './install-helpers.js';

export interface SkillsInstallCommandOptions {
  skillsDir?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  npmPostinstall?: boolean;
  dev?: boolean;
  build?: boolean;
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
    .option('-d, --dev', 'Development mode: symlink skills from cwd package.json (rebuilds reflected immediately)')
    .option('--build', 'Build skills before installing (implies --dev)')
    .option('--debug', 'Enable debug logging')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs skills to Claude Code's skills directory from various sources.

  Supported sources:
  - npm package: npm:@scope/package-name
  - Local ZIP file: ./path/to/skill.zip
  - Local directory: ./path/to/skill-dir
  - npm postinstall: --npm-postinstall (automatic during global install)
  - Dev mode: --dev (symlinks from cwd package.json vat.skills[])

  Default skills directory: ~/.claude/skills/

  Dev mode creates symlinks so rebuilds are immediately reflected.
  Use --build to auto-build before symlinking.

Output:
  - status: success/error
  - skillName: Name of installed skill
  - installPath: Where the skill was installed
  - source: Original source
  - sourceType: npm/local/zip/npm-postinstall/dev

Exit Codes:
  0 - Installation successful
  1 - Installation error (invalid source, skill exists, etc.)
  2 - System error

Example:
  $ vat skills install --dev                        # Symlink all skills from cwd
  $ vat skills install --build                      # Build + symlink
  $ vat skills install --dev --name my-skill        # Symlink specific skill
  $ vat skills install npm:@scope/package           # Install from npm
  $ vat skills install ./my-skill.zip --force       # Install from ZIP
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
    // Handle --build (implies --dev)
    if (options.build) {
      options.dev = true;
    }

    // Handle --dev flag
    if (options.dev) {
      await handleDevInstall(options, logger, startTime);
      return;
    }

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
      case 'dev': {
        // This case is handled by --dev flag, not by source detection
        throw new Error('dev source type should be handled by --dev flag');
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

  if (hasPackageJson) {
    // Read vat metadata - install all skills (or filtered by --name)
    const { packageJson, skills } = await readPackageJsonVatMetadata(sourcePath);

    const skillsToInstall = options.name
      ? skills.filter(s => s.name === options.name)
      : skills;

    if (skillsToInstall.length === 0) {
      throw new Error(
        `Skill "${options.name ?? ''}" not found in package ${packageJson.name}. ` +
          `Available: ${skills.map(s => s.name).join(', ')}`
      );
    }

    for (const skill of skillsToInstall) {
      const skillPath = resolve(sourcePath, skill.path);
      await installSkillFromPath(skillPath, skill.name, options, logger);
    }

    const duration = Date.now() - startTime;
    const firstSkill = skillsToInstall[0];
    if (firstSkill) {
      outputSuccess(
        firstSkill.name,
        join(options.skillsDir ?? getClaudeUserPaths().skillsDir, firstSkill.name),
        `local:${sourcePath}`,
        'local',
        duration,
        logger,
        options.dryRun
      );
    }
  } else {
    // Plain directory - use directory name
    const skillName = options.name ?? basename(sourcePath);
    await installSkillFromPath(sourcePath, skillName, options, logger);

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
  }

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
 * Handle development mode installation (symlinks)
 * Reads package.json vat.skills[], symlinks each built skill to ~/.claude/skills/
 */
async function handleDevInstall(
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number
): Promise<void> {
  // Windows check - symlinks require elevated privileges
  if (process.platform === 'win32') {
    throw new Error(
      '--dev (symlink) not supported on Windows.\n' +
        'Use copy mode (omit --dev) or WSL for development.'
    );
  }

  const cwd = process.cwd();

  // If --build, shell out to vat skills build first
  if (options.build) {
    runSkillsBuild(cwd, options.name, logger);
  }

  // Read package.json for skill metadata
  const { packageJson, skills } = await readPackageJsonVatMetadata(cwd);
  logger.info(`📥 Dev-installing skills from ${packageJson.name}`);

  // Filter by --name if specified
  const skillsToInstall = options.name
    ? skills.filter(s => s.name === options.name)
    : skills;

  if (skillsToInstall.length === 0) {
    const msg = options.name
      ? `Skill "${options.name}" not found in package. Available: ${skills.map(s => s.name).join(', ')}`
      : `No skills found in ${packageJson.name}`;
    throw new Error(msg);
  }

  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;
  const installed: Array<{ name: string; installPath: string; sourcePath: string }> = [];

  for (const skill of skillsToInstall) {
    const result = await symlinkSkill(skill, cwd, skillsDir, options, logger);
    installed.push(result);
  }

  const duration = Date.now() - startTime;
  outputDevSuccess(installed, packageJson.name, duration, logger, options.dryRun);
  process.exit(0);
}

/**
 * Shell out to vat skills build
 */
function runSkillsBuild(
  cwd: string,
  skillName: string | undefined,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info('🔨 Building skills first...');
  const binPath = resolve(join(import.meta.dirname, '../../bin/vat.js'));
  const buildArgs = ['skills', 'build'];
  if (skillName) {
    buildArgs.push('--skill', skillName);
  }
  safeExecSync('node', [binPath, ...buildArgs], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  logger.info('');
}

/**
 * Symlink a single skill to the skills directory
 * Verifies skill is built, checks for existing installation, creates symlink
 */
async function symlinkSkill(
  skill: { name: string; path: string },
  cwd: string,
  skillsDir: string,
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<{ name: string; installPath: string; sourcePath: string }> {
  const sourcePath = resolve(cwd, skill.path);
  const installPath = join(skillsDir, skill.name);

  // Verify skill is built
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path from package.json
  if (!existsSync(sourcePath)) {
    const buildCmd = options.name ? `vat skills build --skill ${skill.name}` : 'vat skills build';
    throw new Error(
      `Skill "${skill.name}" not built at ${sourcePath}\n` +
        `Run: ${buildCmd}\n` +
        `Or use: vat skills install --build`
    );
  }

  // Check existing installation
  const existingIsSymlink = await handleExistingDevInstall(installPath, skill.name, options);

  if (!options.dryRun) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Skills directory from config
    await mkdir(skillsDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths
    await symlink(sourcePath, installPath, 'dir');
  }

  const action = existingIsSymlink ? 'Re-symlinked' : 'Symlinked';
  logger.info(`   ${options.dryRun ? 'Would symlink' : action}: ${skill.name} → ${sourcePath}`);
  return { name: skill.name, installPath, sourcePath };
}

/**
 * Check if a skill is already installed at the target path
 * Returns whether the existing entry was a symlink (for logging)
 */
async function handleExistingDevInstall(
  installPath: string,
  skillName: string,
  options: SkillsInstallCommandOptions
): Promise<boolean> {
  let existingIsSymlink = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated install path
    lstatSync(installPath);
    // Path exists (lstat doesn't follow symlinks, so broken symlinks are detected)
    if (!options.force) {
      throw new Error(
        `Skill "${skillName}" already installed at ${installPath}.\n` +
          `Use --force to overwrite.`
      );
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated install path
    existingIsSymlink = lstatSync(installPath).isSymbolicLink();
    if (!options.dryRun) {
      await rm(installPath, { recursive: true, force: true });
    }
  } catch (error) {
    // Re-throw if it's our "already installed" error
    if (error instanceof Error && error.message.includes('already installed')) {
      throw error;
    }
    // Otherwise: not installed, continue
  }
  return existingIsSymlink;
}

/**
 * Output success YAML for dev install (multiple skills)
 */
function outputDevSuccess(
  installed: Array<{ name: string; installPath: string; sourcePath: string }>,
  packageName: string,
  duration: number,
  logger: ReturnType<typeof createLogger>,
  dryRun?: boolean
): void {
  writeYamlHeader(dryRun);
  process.stdout.write(`sourceType: dev\n`);
  process.stdout.write(`package: "${packageName}"\n`);
  process.stdout.write(`skillsInstalled: ${installed.length}\n`);
  process.stdout.write(`symlink: true\n`);
  process.stdout.write(`skills:\n`);
  for (const skill of installed) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    installPath: ${skill.installPath}\n`);
    process.stdout.write(`    sourcePath: ${skill.sourcePath}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);

  if (dryRun) {
    logger.info(`\n✅ Dry-run complete: ${installed.length} skill(s) would be symlinked`);
  } else {
    logger.info(`\n✅ Dev-installed ${installed.length} skill(s) via symlink`);
    logger.info(`   After rebuilding, run /reload-skills in Claude Code`);
  }
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

  // Check if skill already exists (lstatSync detects broken symlinks too)
  let exists = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Install path from config
    lstatSync(installPath);
    exists = true;
  } catch {
    // Does not exist
  }

  if (exists && !options.force) {
    throw new Error(
      `Skill already exists at ${installPath}. Use --force to overwrite.`
    );
  }

  if (exists && options.force && !options.dryRun) {
    await rm(installPath, { recursive: true, force: true });
  }

  if (!options.dryRun) {
    // Create skills directory
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Skills directory path, safe
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
  writeYamlHeader(dryRun);
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
