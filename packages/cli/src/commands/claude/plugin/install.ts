/**
 * Install skill packages to Claude Code plugins directory
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
import { basename, join, relative, resolve } from 'node:path';

import { getClaudeUserPaths, installPlugin, uninstallPlugin } from '@vibe-agent-toolkit/claude-marketplace';
import { normalizedTmpdir, safeExecSync } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';

import {
  detectSource,
  downloadNpmPackage,
  isGlobalNpmInstall,
  readPackageJsonVatMetadata,
  type PackageJsonVatReplaces,
  type SkillSource,
  writeYamlHeader,
} from './helpers.js';

/** Relative path within a VAT npm package to its pre-built plugin structure. */
const PLUGIN_MARKETPLACES_SUBPATH = join('dist', '.claude', 'plugins', 'marketplaces');
const PACKAGE_JSON = 'package.json';

/**
 * List immediate subdirectory names inside a directory.
 * Returns empty array when the directory does not exist.
 */
function listSubdirectories(dir: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validates dir
  if (!existsSync(dir)) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller validates dir
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

/**
 * Register a plugin in the Claude plugin registry, logging a warning on failure.
 */
async function registerPlugin(
  mpName: string,
  pluginName: string,
  pluginDir: string,
  version: string,
  packageName: string,
  paths: ReturnType<typeof getClaudeUserPaths>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    await installPlugin({
      marketplaceName: mpName,
      pluginName,
      pluginDir,
      version,
      source: { source: 'npm', package: packageName, version },
      paths,
    });
    logger.info(`   Registered plugin ${pluginName}@${mpName} in Claude plugin registry`);
  } catch (error) {
    logger.info(`   Warning: Could not register plugin ${pluginName}: ${String(error)}`);
  }
}

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
  const packageJson = JSON.parse(pkgRaw) as { name: string; version?: string; vat?: { replaces?: PackageJsonVatReplaces } };
  await copyPluginTree(marketplacesDir, packageJson, logger, dryRun);

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

export interface PluginInstallCommandOptions {
  skillsDir?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  npmPostinstall?: boolean;
  dev?: boolean;
  build?: boolean;
  userInstallWithoutPlugin?: boolean;
  target?: string;
}

export function createPluginInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install skill packages to Claude Code plugins directory')
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
    .option('--target <target>', 'Target surface: code (default), claude.ai', 'code')
    .option('--debug', 'Enable debug logging')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs skill packages to Claude Code's plugins directory from various sources.

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
  $ vat claude plugin install --dev                        # Symlink all skills from cwd
  $ vat claude plugin install --build                      # Build + symlink
  $ vat claude plugin install npm:@scope/package           # Install from npm
`
    );

  return command;
}

async function installCommand(
  source: string | undefined,
  options: PluginInstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Handle --target claude.ai stub
    const target = options.target ?? 'code';
    if (target === 'claude.ai') {
      // Write separator directly — cannot use writeYamlHeader() which outputs status: success
      process.stdout.write(`---\n`);
      process.stdout.write(`status: not-available\n`);
      process.stdout.write(`reason: "claude.ai org provisioning API not yet confirmed as public"\n`);
      process.stdout.write(`requestedTarget: claude.ai\n`);
      process.stdout.write(`guidance: "Use claude.ai admin console to upload a .zip manually, or use --target api.anthropic.com for workspace-scoped skill management"\n`);
      process.exit(1);
    }

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
    handleCommandError(error, logger, startTime, 'PluginInstall');
  }
}

/**
 * Handle npm package installation
 */
async function handleNpmInstall(
  source: string,
  options: PluginInstallCommandOptions,
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
  options: PluginInstallCommandOptions,
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
  options: PluginInstallCommandOptions,
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
 * Prepare destination for a dev symlink: remove any existing entry if --force.
 * Throws if the path exists and --force was not passed.
 */
async function prepareDevSymlinkDest(
  destPath: string,
  skillFsName: string,
  options: PluginInstallCommandOptions
): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
    lstatSync(destPath);
    if (!options.force) {
      throw new Error(
        `Skill "${skillFsName}" already installed at ${destPath}.\n` +
          `Use --force to overwrite.`
      );
    }
    if (!options.dryRun) {
      await rm(destPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('already installed')) {
      throw error;
    }
    // Does not exist — that's fine
  }
}

/**
 * Symlink a single skill directory from dist/skills/{name} into the plugin tree.
 * Returns install info, or null when the skill is not built (skips with a warning).
 */
async function symlinkDevSkill(
  skillFsName: string,
  destSkillsDir: string,
  cwd: string,
  pluginName: string,
  options: PluginInstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<{ name: string; installPath: string; sourcePath: string } | null> {
  const srcSkillPath = resolve(cwd, 'dist', 'skills', skillFsName);
  const destSkillPath = join(destSkillsDir, skillFsName);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (!existsSync(srcSkillPath)) {
    logger.info(`   Warning: skill not built at ${srcSkillPath} — skipping symlink`);
    return null;
  }

  await prepareDevSymlinkDest(destSkillPath, skillFsName, options);

  if (!options.dryRun) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
    await symlink(srcSkillPath, destSkillPath, 'dir');
  }

  logger.info(`   Symlinked: ${relative(cwd, destSkillPath)} → ${srcSkillPath}`);
  return {
    name: `${pluginName}:${skillFsName}`,
    installPath: destSkillPath,
    sourcePath: srcSkillPath,
  };
}

interface DevPluginContext {
  mpName: string;
  pluginName: string;
  srcPluginDir: string;
  destPluginDir: string;
  packageName: string;
  version: string;
  paths: ReturnType<typeof getClaudeUserPaths>;
}

/**
 * Symlink all skill directories from a plugin's source skills dir into the destination.
 */
async function symlinkPluginSkills(
  srcPluginDir: string,
  destPluginDir: string,
  pluginName: string,
  cwd: string,
  options: PluginInstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<Array<{ name: string; installPath: string; sourcePath: string }>> {
  const installed: Array<{ name: string; installPath: string; sourcePath: string }> = [];
  const srcSkillsDir = join(srcPluginDir, 'skills');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (!existsSync(srcSkillsDir)) {
    return installed;
  }

  const destSkillsDir = join(destPluginDir, 'skills');
  if (!options.dryRun) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
    await mkdir(destSkillsDir, { recursive: true });
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  const skillEntries = readdirSync(srcSkillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const skillEntry of skillEntries) {
    const result = await symlinkDevSkill(skillEntry.name, destSkillsDir, cwd, pluginName, options, logger);
    if (result) {
      installed.push(result);
    }
  }

  return installed;
}

/**
 * Dev-install a single plugin: copy non-skill content, symlink skills, register.
 */
async function devInstallPlugin(
  ctx: DevPluginContext,
  cwd: string,
  options: PluginInstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<Array<{ name: string; installPath: string; sourcePath: string }>> {
  const { mpName, pluginName, srcPluginDir, destPluginDir, packageName, version, paths } = ctx;

  if (!options.dryRun) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
    await mkdir(destPluginDir, { recursive: true });
  }

  // Copy non-skill entries (e.g. .claude-plugin/)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  for (const entry of readdirSync(srcPluginDir, { withFileTypes: true })) {
    if (entry.name !== 'skills' && !options.dryRun) {
      const srcEntry = join(srcPluginDir, entry.name);
      const destEntry = join(destPluginDir, entry.name);
      await cp(srcEntry, destEntry, { recursive: true, force: true });
    }
  }

  const installed = await symlinkPluginSkills(srcPluginDir, destPluginDir, pluginName, cwd, options, logger);

  // Register plugin in Claude plugin registry
  if (!options.dryRun) {
    await registerPlugin(mpName, pluginName, destPluginDir, version, packageName, paths, logger);
  }

  return installed;
}

/**
 * Dev-install a single marketplace: reset dir, copy non-plugin content, install each plugin.
 */
async function devInstallMarketplace(
  mpName: string,
  srcMpDir: string,
  packageInfo: { name: string; version: string },
  cwd: string,
  options: PluginInstallCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<Array<{ name: string; installPath: string; sourcePath: string }>> {
  const paths = getClaudeUserPaths();
  const destMpDir = join(paths.marketplacesDir, mpName);
  const installed: Array<{ name: string; installPath: string; sourcePath: string }> = [];

  if (!options.dryRun) {
    await rm(destMpDir, { recursive: true, force: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
    await mkdir(destMpDir, { recursive: true });
  }
  logger.info(`   Marketplace: ${mpName} → ${destMpDir}`);

  // Copy non-plugin content (e.g. .claude-plugin/marketplace.json)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  for (const entry of readdirSync(srcMpDir, { withFileTypes: true })) {
    if (entry.name !== 'plugins' && !options.dryRun) {
      const srcEntry = join(srcMpDir, entry.name);
      const destEntry = join(destMpDir, entry.name);
      await cp(srcEntry, destEntry, { recursive: true, force: true });
    }
  }

  const pluginsDir = join(srcMpDir, 'plugins');

  for (const pluginName of listSubdirectories(pluginsDir)) {
    const results = await devInstallPlugin(
      {
        mpName,
        pluginName,
        srcPluginDir: join(pluginsDir, pluginName),
        destPluginDir: join(destMpDir, 'plugins', pluginName),
        packageName: packageInfo.name,
        version: packageInfo.version,
        paths,
      },
      cwd,
      options,
      logger
    );
    installed.push(...results);
  }

  return installed;
}

/**
 * Handle development mode installation via plugin tree (symlinks).
 *
 * Reads the pre-built plugin tree from dist/.claude/plugins/marketplaces/:
 * - Copies non-skill content (.claude-plugin/ dirs) to ~/.claude/plugins/
 * - For each skill directory under plugins/{plugin}/skills/{name}/, creates a
 *   symlink to the corresponding dist/skills/{name}/ directory
 * - Registers each plugin in the Claude plugin registry (same as copyPluginTree)
 *
 * Skills appear in Claude Code as {plugin}:{skill} instead of the flat {skill} name.
 */
async function handleDevInstall(
  options: PluginInstallCommandOptions,
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
    runBuild(cwd, logger);
  }

  // Check for pre-built plugin tree
  const marketplacesDir = join(cwd, PLUGIN_MARKETPLACES_SUBPATH);
  if (!existsSync(marketplacesDir)) {
    throw new Error(
      `Plugin tree not found at ${marketplacesDir}\n` +
        `Run: vat build first (builds the plugin tree)`
    );
  }

  // Read package.json for package name/version
  const pkgRaw = readFileSync(join(cwd, PACKAGE_JSON), 'utf-8');
  const packageJson = JSON.parse(pkgRaw) as { name: string; version?: string; vat?: { replaces?: PackageJsonVatReplaces } };
  logger.info(`📥 Dev-installing plugin tree from ${packageJson.name}`);

  const packageInfo = { name: packageJson.name, version: packageJson.version ?? '0.0.0' };
  const installed: Array<{ name: string; installPath: string; sourcePath: string }> = [];

  // Remove old plugins/flat skills this package replaces, before installing
  if (packageJson.vat?.replaces) {
    const paths = getClaudeUserPaths();
    const marketplaceNames = listSubdirectories(marketplacesDir);
    await executeReplaces(packageJson.vat.replaces, marketplaceNames, paths, options.dryRun ?? false, logger);
  }

  for (const mpName of listSubdirectories(marketplacesDir)) {
    const srcMpDir = join(marketplacesDir, mpName);
    const results = await devInstallMarketplace(mpName, srcMpDir, packageInfo, cwd, options, logger);
    installed.push(...results);
  }

  const duration = Date.now() - startTime;
  outputDevSuccess(installed, packageJson.name, duration, logger, options.dryRun);
  process.exit(0);
}

/**
 * Shell out to vat build (skills + claude plugin tree)
 */
function runBuild(
  cwd: string,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info('🔨 Building first (skills + plugin tree)...');
  const binPath = resolve(join(import.meta.dirname, '../../../../bin/vat.js'));
  safeExecSync('node', [binPath, 'build'], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  logger.info('');
}


/**
 * Handle npm postinstall hook
 */
async function handleNpmPostinstall(
  options: PluginInstallCommandOptions,
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
      const packageJson = JSON.parse(pkgRaw) as { name: string; version?: string; vat?: { replaces?: PackageJsonVatReplaces } };
      logger.info(`   Package: ${packageJson.name}@${packageJson.version ?? 'unknown'}`);
      logger.info(`   Plugin tree detected — copying to ~/.claude/plugins/`);
      await copyPluginTree(marketplacesDir, packageJson, logger, options.dryRun);

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
 * Execute vat.replaces cleanup before installing the new plugin.
 *
 * Removes old plugin registrations and legacy flat-skill installs that this
 * package now supersedes. Runs before the new plugin is copied/symlinked so
 * Claude Code never sees stale duplicate entries.
 *
 * Idempotent — uninstallPlugin handles "not found" gracefully.
 */
async function executeReplaces(
  replaces: PackageJsonVatReplaces,
  marketplaceNames: string[],
  paths: ReturnType<typeof getClaudeUserPaths>,
  dryRun: boolean,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  // Remove old plugin entries from all marketplaces this package ships into
  for (const mp of marketplaceNames) {
    for (const oldPlugin of replaces.plugins ?? []) {
      const pluginKey = `${oldPlugin}@${mp}`;
      if (dryRun) {
        logger.info(`   [dry-run] Would uninstall old plugin: ${pluginKey}`);
      } else {
        logger.info(`   Removing old plugin: ${pluginKey}`);
        await uninstallPlugin({ pluginKey, paths, dryRun: false });
      }
    }
  }

  // Remove legacy flat-skill installs from ~/.claude/skills/<name>
  for (const skillName of replaces.flatSkills ?? []) {
    const skillPath = join(paths.skillsDir, skillName);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from Claude user paths + skill name
    if (existsSync(skillPath)) {
      if (dryRun) {
        logger.info(`   [dry-run] Would remove legacy flat skill: ${skillPath}`);
      } else {
        logger.info(`   Removing legacy flat skill: ${skillPath}`);
        await rm(skillPath, { recursive: true, force: true });
      }
    }
  }
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
  packageJson: { name: string; version?: string; vat?: { replaces?: PackageJsonVatReplaces } },
  logger: ReturnType<typeof createLogger>,
  dryRun?: boolean
): Promise<void> {
  const paths = getClaudeUserPaths();
  const version = packageJson.version ?? '0.0.0';
  const marketplaceNames = listSubdirectories(marketplacesDir);

  // Remove any old plugins/flat skills this package replaces, before installing
  if (packageJson.vat?.replaces) {
    await executeReplaces(packageJson.vat.replaces, marketplaceNames, paths, dryRun ?? false, logger);
  }

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

    // Register each plugin within the marketplace
    for (const pluginName of listSubdirectories(join(srcMpDir, 'plugins'))) {
      const pluginDir = join(destMpDir, 'plugins', pluginName);
      await registerPlugin(mpName, pluginName, pluginDir, version, packageJson.name, paths, logger);
    }
  }
}

/**
 * Prepare plugins directory and check for conflicts
 */
async function prepareInstallation(
  skillName: string,
  options: PluginInstallCommandOptions
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
  options: PluginInstallCommandOptions,
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
    logger.info(`\n💡 Run 'vat claude plugin list' to verify installation`);
    logger.info(`   Restart Claude Code or run /reload-skills to use the new skill`);
  }
}
