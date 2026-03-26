/**
 * Install skills to Claude's plugins directory
 *
 * Supports installing from:
 * - npm packages (npm:@scope/package)
 * - Local ZIP file
 * - Local directory
 * - npm postinstall hook (--npm-postinstall)
 *
 * Plugin detection: looks for dist/.claude/plugins/marketplaces/ directory.
 * When present, copies the pre-built directory tree to ~/.claude/plugins/
 * and updates Claude's plugin registry files. When absent, falls back to
 * copying dist/skills/ to ~/.claude/skills/.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { getClaudeUserPaths, installPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { normalizedTmpdir, safeExecSync } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { Command } from 'commander';

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

/** Relative path within a VAT npm package to its pre-built plugin structure. */
const PLUGIN_MARKETPLACES_SUBPATH = join('dist', '.claude', 'plugins', 'marketplaces');
const PACKAGE_JSON = 'package.json';

/**
 * Install from a pre-built plugin tree: read package.json, copy tree, output success.
 * Shared between npm and local install paths to avoid duplication.
 */
async function installPluginTreeAndExit(
  rootDir: string,
  marketplacesDir: string,
  sourceLabel: string,
  sourceType: SkillSource,
  startTime: number,
  logger: ReturnType<typeof createLogger>,
  dryRun?: boolean,
): Promise<never> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- rootDir from controlled source
  const pkgRaw = readFileSync(join(rootDir, PACKAGE_JSON), 'utf-8');
  const packageJson = JSON.parse(pkgRaw) as { name: string; version?: string };
  await copyPluginTree(marketplacesDir, packageJson, logger);

  const duration = Date.now() - startTime;
  outputInstallSuccess([], sourceLabel, sourceType, duration, logger, dryRun);
  process.exit(0);
}

/**
 * Convert a skill name to a filesystem-safe path segment.
 * Colons in colon-namespaced names (e.g. "pkg:sub") become "__".
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

export interface SkillsInstallCommandOptions {
  skillsDir?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  npmPostinstall?: boolean;
  dev?: boolean;
  build?: boolean;
  userInstallWithoutPlugin?: boolean;
}

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install skills to Claude Code plugins directory')
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
    .option('-d, --dev', 'Development mode: symlink skills from dist/skills/ (rebuilds reflected immediately)')
    .option('--build', 'Build skills before installing (implies --dev)')
    .option('--user-install-without-plugin', 'Force skills-only install (skip plugin registry even if dist/.claude/ exists)', false)
    .option('--debug', 'Enable debug logging')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs skills to Claude Code's plugins directory from various sources.

  Plugin detection: If the package contains dist/.claude/plugins/marketplaces/,
  the pre-built directory tree is copied to ~/.claude/plugins/ (dumb copy).
  Otherwise, falls back to copying dist/skills/ to ~/.claude/skills/.

  Supported sources:
  - npm package: npm:@scope/package-name
  - Local ZIP file: ./path/to/skill.zip
  - Local directory: ./path/to/skill-dir
  - npm postinstall: --npm-postinstall (automatic during global install)
  - Dev mode: --dev (symlinks from dist/skills/)

Output:
  - status: success/error
  - source: Original source
  - sourceType: npm/local/zip/npm-postinstall/dev

Exit Codes:
  0 - Installation successful
  1 - Installation error (invalid source, skill exists, etc.)
  2 - System error

Example:
  $ vat skills install --dev                        # Symlink all skills from cwd
  $ vat skills install --build                      # Build + symlink
  $ vat skills install npm:@scope/package           # Install from npm
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
        throw new Error('npm-postinstall source type should be handled by --npm-postinstall flag');
      }
      case 'dev': {
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

    // If the package ships a pre-built plugin tree, install via dumb copy.
    const marketplacesDir = join(extractedPath, PLUGIN_MARKETPLACES_SUBPATH);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from controlled extractedPath + constant subpath
    const hasPlugin = !options.userInstallWithoutPlugin && existsSync(marketplacesDir);

    if (hasPlugin) {
      logger.info('   Plugin detected — installing via Claude plugin system');
      await installPluginTreeAndExit(extractedPath, marketplacesDir, `npm:${packageName}`, 'npm', startTime, logger, options.dryRun);
    }

    // No plugin tree — install skills directly to ~/.claude/skills/
    const { skills } = await readPackageJsonVatMetadata(extractedPath);

    if (skills.length === 0) {
      throw new Error(`No skills found in package ${packageName}`);
    }

    // Filter by --name if specified
    const skillNames = options.name
      ? skills.filter(s => s === options.name)
      : skills;

    if (skillNames.length === 0) {
      throw new Error(
        `Skill "${options.name ?? ''}" not found in package ${packageName}. ` +
          `Available: ${skills.join(', ')}`
      );
    }

    const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;

    for (const skillName of skillNames) {
      const skillPath = join(extractedPath, 'dist', 'skills', skillNameToFsPath(skillName));
      await installSkillFromPath(skillPath, skillName, options, logger);
    }

    const duration = Date.now() - startTime;
    outputInstallSuccess(
      skillNames.map(name => ({
        name,
        installPath: join(skillsDir, name),
      })),
      `npm:${packageName}`,
      'npm',
      duration,
      logger,
      options.dryRun
    );

    process.exit(0);
  } finally {
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

  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;

  // Check for pre-built plugin tree first
  const marketplacesDir = join(sourcePath, PLUGIN_MARKETPLACES_SUBPATH);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  if (!options.userInstallWithoutPlugin && existsSync(marketplacesDir)) {
    await installPluginTreeAndExit(sourcePath, marketplacesDir, `local:${sourcePath}`, 'local', startTime, logger, options.dryRun);
  }

  // Check if directory contains package.json with vat.skills
  const packageJsonPath = join(sourcePath, 'package.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  const hasPackageJson = existsSync(packageJsonPath);

  let installed: Array<{ name: string; installPath: string }>;

  if (hasPackageJson) {
    const { packageJson, skills } = await readPackageJsonVatMetadata(sourcePath);
    const skillNames = options.name ? skills.filter(s => s === options.name) : skills;

    if (skillNames.length === 0) {
      throw new Error(
        `Skill "${options.name ?? ''}" not found in package ${packageJson.name}. ` +
          `Available: ${skills.join(', ')}`
      );
    }

    for (const skillName of skillNames) {
      const skillPath = join(sourcePath, 'dist', 'skills', skillNameToFsPath(skillName));
      await installSkillFromPath(skillPath, skillName, options, logger);
    }

    installed = skillNames.map(name => ({ name, installPath: join(skillsDir, name) }));
  } else {
    // Plain directory - use directory name
    const skillName = options.name ?? basename(sourcePath);
    await installSkillFromPath(sourcePath, skillName, options, logger);
    installed = [{ name: skillName, installPath: join(skillsDir, skillName) }];
  }

  const duration = Date.now() - startTime;
  outputInstallSuccess(installed, `local:${sourcePath}`, 'local', duration, logger, options.dryRun);
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

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
  if (!existsSync(sourcePath)) {
    throw new Error(`ZIP file not found: ${sourcePath}`);
  }

  const skillName = options.name ?? basename(sourcePath, '.zip');
  const { installPath } = await prepareInstallation(skillName, options);

  if (!options.dryRun) {
    logger.info('   Extracting ZIP...');
    const zip = new AdmZip(sourcePath);
    // eslint-disable-next-line sonarjs/no-unsafe-unzip -- User-provided local files, isolated plugin directory
    zip.extractAllTo(installPath, /* overwrite */ true);
  }

  const duration = Date.now() - startTime;
  outputInstallSuccess(
    [{ name: skillName, installPath }],
    sourcePath,
    'zip',
    duration,
    logger,
    options.dryRun
  );

  process.exit(0);
}

/**
 * Install a single skill as a dev symlink.
 * Extracted from handleDevInstall to reduce cognitive complexity.
 */
async function installDevSkill(
  skillName: string,
  cwd: string,
  skillsDir: string,
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<{ name: string; installPath: string; sourcePath: string }> {
  const fsPath = skillNameToFsPath(skillName);
  const sourcePath = resolve(cwd, 'dist', 'skills', fsPath);
  const installPath = join(skillsDir, skillName);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path from package.json
  if (!existsSync(sourcePath)) {
    const buildCmd = options.name ? `vat skills build --skill ${skillName}` : 'vat skills build';
    throw new Error(
      `Skill "${skillName}" not built at ${sourcePath}\n` +
        `Run: ${buildCmd}\n` +
        `Or use: vat skills install --build`
    );
  }

  const existingIsSymlink = await handleExistingDevInstall(installPath, skillName, options);

  if (!options.dryRun) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Skills directory from config
    await mkdir(skillsDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated paths
    await symlink(sourcePath, installPath, 'dir');
  }

  const action = existingIsSymlink ? 'Re-symlinked' : 'Symlinked';
  logger.info(`   ${options.dryRun ? 'Would symlink' : action}: ${skillName} → ${sourcePath}`);
  return { name: skillName, installPath, sourcePath };
}

/**
 * Handle development mode installation (symlinks)
 * Reads package.json vat.skills[] (skill name strings), symlinks each built skill to ~/.claude/skills/
 */
async function handleDevInstall(
  options: SkillsInstallCommandOptions,
  logger: ReturnType<typeof createLogger>,
  startTime: number
): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      '--dev (symlink) not supported on Windows.\n' +
        'Use copy mode (omit --dev) or WSL for development.'
    );
  }

  const cwd = process.cwd();

  if (options.build) {
    runSkillsBuild(cwd, options.name, logger);
  }

  // Read package.json for skill names
  const { packageJson, skills } = await readPackageJsonVatMetadata(cwd);
  logger.info(`📥 Dev-installing skills from ${packageJson.name}`);

  // Filter by --name if specified
  const skillNames = options.name
    ? skills.filter(s => s === options.name)
    : skills;

  if (skillNames.length === 0) {
    const msg = options.name
      ? `Skill "${options.name}" not found in package. Available: ${skills.join(', ')}`
      : `No skills found in ${packageJson.name}`;
    throw new Error(msg);
  }

  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;
  const installed: Array<{ name: string; installPath: string; sourcePath: string }> = [];

  for (const skillName of skillNames) {
    const result = await installDevSkill(skillName, cwd, skillsDir, options, logger);
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
 * Check if a skill is already installed at the target path
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
    if (error instanceof Error && error.message.includes('already installed')) {
      throw error;
    }
  }
  return existingIsSymlink;
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

  if (!isGlobalNpmInstall()) {
    logger.info('   Skipping: Not a global npm install');
    process.exit(0);
  }

  const cwd = process.cwd();

  // Check for pre-built plugin tree (dist/.claude/plugins/marketplaces/)
  const marketplacesDir = join(cwd, PLUGIN_MARKETPLACES_SUBPATH);
  const hasPluginTree = existsSync(marketplacesDir);

  if (!options.userInstallWithoutPlugin) {
    if (hasPluginTree) {
      const pkgRaw = readFileSync(join(cwd, PACKAGE_JSON), 'utf-8');
      const packageJson = JSON.parse(pkgRaw) as { name: string; version?: string };
      logger.info(`   Package: ${packageJson.name}@${packageJson.version ?? 'unknown'}`);
      logger.info(`   Plugin tree detected — copying to ~/.claude/plugins/`);
      await copyPluginTree(marketplacesDir, packageJson, logger);

      const duration = Date.now() - startTime;
      logger.info(`✅ Installed plugin from ${packageJson.name}`);
      logger.info(`   Duration: ${duration}ms`);
    } else {
      logger.info(`   No plugin tree found at dist/.claude/plugins/marketplaces/`);
      logger.info(`   Run 'vat build' to generate plugin artifacts before publishing.`);
      logger.info(`   Skipping install — no skills registered.`);
    }

    process.exit(0);
  }

  // --user-install-without-plugin: install skills directly to ~/.claude/skills/
  const { packageJson, skills } = await readPackageJsonVatMetadata(cwd);

  logger.info(`   Package: ${packageJson.name}@${packageJson.version}`);
  logger.info(`   Skills found: ${skills.length}`);

  for (const skillName of skills) {
    const skillPath = join(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
    await installSkillFromPath(skillPath, skillName, options, logger);
  }

  const duration = Date.now() - startTime;
  logger.info(`✅ Installed ${skills.length} skill(s) from ${packageJson.name}`);
  logger.info(`   Duration: ${duration}ms`);

  process.exit(0);
}

/**
 * Copy pre-built plugin tree to ~/.claude/plugins/ and update registry.
 *
 * This is a "dumb copy" — the dist/.claude/plugins/marketplaces/ tree mirrors
 * the target ~/.claude/plugins/marketplaces/ structure exactly. No path rewriting,
 * no assembly, no skill resolution. Just recursive copy + registry update.
 */
async function copyPluginTree(
  marketplacesDir: string,
  packageJson: { name: string; version?: string },
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const paths = getClaudeUserPaths();
  const version = packageJson.version ?? '0.0.0';

  // Scan for marketplace directories
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolved from constant subpath
  const marketplaceNames = readdirSync(marketplacesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const mpName of marketplaceNames) {
    const srcMpDir = join(marketplacesDir, mpName);
    const destMpDir = join(paths.marketplacesDir, mpName);

    // Replace the marketplace directory entirely so skills removed from the
    // package do not persist in the user's Claude installation.
    logger.info(`   Copying marketplace: ${mpName} → ${destMpDir}`);
    await rm(destMpDir, { recursive: true, force: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolved from constant subpath
    await mkdir(destMpDir, { recursive: true });
    await cp(srcMpDir, destMpDir, { recursive: true, force: true });

    // Discover plugins within the marketplace for registry updates
    const pluginsDir = join(srcMpDir, 'plugins');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolved from constant subpath
    if (!existsSync(pluginsDir)) {
      continue;
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Resolved from constant subpath
    const pluginNames = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const pluginName of pluginNames) {
      const pluginDir = join(destMpDir, 'plugins', pluginName);
      try {
        await installPlugin({
          marketplaceName: mpName,
          pluginName,
          pluginDir,
          version,
          source: { source: 'npm', package: packageJson.name, version },
          paths,
        });
        logger.info(`   Registered plugin ${pluginName}@${mpName} in Claude plugin registry`);
      } catch (error) {
        logger.info(`   Warning: Could not register plugin ${pluginName}: ${String(error)}`);
      }
    }
  }
}

/**
 * Prepare plugins directory and check for conflicts
 */
async function prepareInstallation(
  skillName: string,
  options: SkillsInstallCommandOptions
): Promise<{ skillsDir: string; installPath: string }> {
  const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;
  const installPath = join(skillsDir, skillName);

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
    logger.info(`   Installing ${skillName}...`);
    await cp(skillPath, installPath, { recursive: true, force: true });
  }
}

/**
 * Output success YAML for dev install
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
 * Output success YAML for install
 */
function outputInstallSuccess(
  skills: Array<{ name: string; installPath: string }>,
  source: string,
  sourceType: SkillSource,
  duration: number,
  logger: ReturnType<typeof createLogger>,
  dryRun?: boolean
): void {
  writeYamlHeader(dryRun);
  process.stdout.write(`source: ${source}\n`);
  process.stdout.write(`sourceType: ${sourceType}\n`);
  process.stdout.write(`skillsInstalled: ${skills.length}\n`);
  process.stdout.write(`skills:\n`);
  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    installPath: ${skill.installPath}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);

  if (dryRun) {
    logger.info(`\n✅ Dry-run complete: ${skills.length} skill(s) would be installed`);
  } else {
    logger.info(`\n✅ Installed ${skills.length} skill(s)`);
    logger.info(`\n💡 Run 'vat skills list' to verify installation`);
    logger.info(`   Restart Claude Code or run /reload-skills to use the new skill`);
  }
}
