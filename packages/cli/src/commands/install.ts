/**
 * Unified install command — auto-detects resource type and installs to correct directory
 *
 * Supported resource types:
 * - agent-skill       (SKILL.md at root)          → ~/.claude/skills/
 * - claude-plugin     (.claude-plugin/plugin.json) → ~/.claude/plugins/
 * - claude-marketplace (.claude-plugin/marketplace.json) → ~/.claude/marketplaces/
 */

import { existsSync, lstatSync, cpSync } from 'node:fs';
import {  mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  checkSettingsCompatibility,
  getClaudeUserPaths,
  readEffectiveSettings,
} from '@vibe-agent-toolkit/claude-marketplace';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

import { writeYamlHeader } from './claude/plugin/helpers.js';

export type ResourceType = 'agent-skill' | 'claude-plugin' | 'claude-marketplace';

/** Directory name used by Claude plugins and marketplaces */
const CLAUDE_PLUGIN_DIR = '.claude-plugin';

/** Agent skill resource type */
const RT_AGENT_SKILL = 'agent-skill' as const;
/** Claude plugin resource type */
const RT_CLAUDE_PLUGIN = 'claude-plugin' as const;
/** Claude marketplace resource type */
const RT_CLAUDE_MARKETPLACE = 'claude-marketplace' as const;

/**
 * Expected installation failure (exit code 1).
 * Used for user-fixable errors: resource exists, wrong --type, etc.
 */
class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export interface InstallCommandOptions {
  type?: ResourceType;
  skillsDir?: string;
  pluginsDir?: string;
  marketplacesDir?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  compatCheck?: boolean; // Commander sets to false when --no-compat-check is used
  debug?: boolean;
}

/**
 * Auto-detect resource type from directory structure.
 * Detection order: marketplace.json → plugin.json → SKILL.md
 * Throws a descriptive error if no recognised structure is found.
 */
export function detectResourceType(sourcePath: string): ResourceType {
  const claudePluginDir = safePath.join(sourcePath, CLAUDE_PLUGIN_DIR);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from user-provided CLI argument
  if (existsSync(claudePluginDir)) {
    const marketplaceJson = safePath.join(claudePluginDir, 'marketplace.json');
    const pluginJson = safePath.join(claudePluginDir, 'plugin.json');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from validated directory
    if (existsSync(marketplaceJson)) {
      return RT_CLAUDE_MARKETPLACE;
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from validated directory
    if (existsSync(pluginJson)) {
      return RT_CLAUDE_PLUGIN;
    }
  }

  const skillMd = safePath.join(sourcePath, 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from user-provided CLI argument
  if (existsSync(skillMd)) {
    return RT_AGENT_SKILL;
  }

  throw new InstallError(
    `Cannot detect resource type for: ${sourcePath}\n` +
      `Expected one of:\n` +
      `  - SKILL.md at root (${RT_AGENT_SKILL})\n` +
      `  - ${CLAUDE_PLUGIN_DIR}/plugin.json (${RT_CLAUDE_PLUGIN})\n` +
      `  - ${CLAUDE_PLUGIN_DIR}/marketplace.json (${RT_CLAUDE_MARKETPLACE})`
  );
}

/**
 * Maps each resource type to its install directory getter.
 * Using a record avoids switch statements that duplicate the type string literals.
 */
type InstallDirGetter = (options: InstallCommandOptions) => string;

const INSTALL_DIR_MAP: Record<ResourceType, InstallDirGetter> = {
  [RT_AGENT_SKILL]: (o) => o.skillsDir ?? getClaudeUserPaths().skillsDir,
  [RT_CLAUDE_PLUGIN]: (o) => o.pluginsDir ?? getClaudeUserPaths().pluginsDir,
  [RT_CLAUDE_MARKETPLACE]: (o) => o.marketplacesDir ?? getClaudeUserPaths().marketplacesDir,
};

/**
 * Resolve the install directory for a given resource type.
 * CLI flags override defaults.
 */
function resolveInstallDir(type: ResourceType, options: InstallCommandOptions): string {
  return INSTALL_DIR_MAP[type](options);
}

/**
 * Expected file path within the source directory for each resource type.
 * Used to validate that --type matches the actual directory structure.
 */
const TYPE_VALIDATION_PATHS: Record<ResourceType, string> = {
  [RT_AGENT_SKILL]: 'SKILL.md',
  [RT_CLAUDE_PLUGIN]: safePath.join(CLAUDE_PLUGIN_DIR, 'plugin.json'),
  [RT_CLAUDE_MARKETPLACE]: safePath.join(CLAUDE_PLUGIN_DIR, 'marketplace.json'),
};

/**
 * Validate that the source directory actually contains the claimed resource type.
 * When --type is provided we still verify the structure exists to catch user mistakes.
 * Throws InstallError (exit 1) when the structure does not match the declared type.
 */
function validateResourceStructure(sourcePath: string, type: ResourceType): void {
  const expectedRelPath = TYPE_VALIDATION_PATHS[type];
  const expectedPath = safePath.join(sourcePath, expectedRelPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from CLI argument
  if (!existsSync(expectedPath)) {
    throw new InstallError(
      `--type ${type} specified but ${expectedRelPath} not found in: ${sourcePath}`
    );
  }
}

/**
 * Prepare the install path: check for conflicts and ensure directory exists.
 * Returns the install path and whether the target already exists.
 */
async function prepareInstallPath(
  installDir: string,
  resourceName: string,
  options: InstallCommandOptions
): Promise<{ installPath: string; alreadyExists: boolean }> {
  const installPath = safePath.join(installDir, resourceName);

  // Check whether target already exists (lstatSync detects broken symlinks too)
  let alreadyExists = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Install path is constructed from config
    lstatSync(installPath);
    alreadyExists = true;
  } catch {
    // Does not exist — continue
  }

  // Dry-run: report the current state without modifying anything
  if (!options.dryRun) {
    if (alreadyExists && !options.force) {
      throw new InstallError(
        `Resource already installed at ${installPath}. Use --force to overwrite.`
      );
    }

    if (alreadyExists && options.force) {
      await rm(installPath, { recursive: true, force: true });
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Install directory from config
    await mkdir(installDir, { recursive: true });
  }

  return { installPath, alreadyExists };
}

interface OutputSuccessArgs {
  resourceName: string;
  installPath: string;
  source: string;
  resourceType: ResourceType;
  duration: number;
  options: InstallCommandOptions;
  logger: ReturnType<typeof createLogger>;
  alreadyExists?: boolean;
}

/**
 * Output YAML success result to stdout
 */
function outputSuccess({
  resourceName,
  installPath,
  source,
  resourceType,
  duration,
  options,
  logger,
  alreadyExists = false,
}: OutputSuccessArgs): void {
  writeYamlHeader(options.dryRun);
  process.stdout.write(`source: ${source}\n`);
  process.stdout.write(`sourceType: ${resourceType}\n`);
  process.stdout.write(`name: ${resourceName}\n`);
  process.stdout.write(`installPath: ${installPath}\n`);
  if (options.dryRun && alreadyExists) {
    process.stdout.write(`alreadyInstalled: true\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);

  if (options.dryRun) {
    const action = alreadyExists ? 'already installed (no changes needed)' : `would install as ${resourceType}`;
    logger.info(`\nDry-run complete: ${resourceName} ${action}`);
  } else {
    logger.info(`\nInstalled ${resourceName} as ${resourceType}`);
    logger.info(`  Path: ${installPath}`);
  }
}

/**
 * Post-install settings advisory: check installed resource against active settings.
 * Best-effort, non-blocking (only prints to stderr, never throws).
 */
async function runPostInstallSettingsAdvisory(
  installPath: string,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    const effectiveSettings = await readEffectiveSettings({ projectDir: process.cwd() });

    // Only run if there are any deny rules (otherwise there's nothing to conflict with)
    if (effectiveSettings.permissions.deny.length === 0 && !effectiveSettings.disableAllHooks?.value) {
      return;
    }

    const conflicts = await checkSettingsCompatibility(installPath, effectiveSettings);

    if (conflicts.length > 0) {
      logger.error(`\n\u26a0 Settings advisory: ${conflicts.length} conflict(s) detected`);
      for (const conflict of conflicts) {
        const settingsFile = basename(conflict.settingsFile);
        logger.error(`  ${conflict.detail}`);
        logger.error(`    blocked by: ${conflict.value} in ${settingsFile} (${conflict.settingsLevel})`);
      }
      logger.error(`  Run \`vat audit --compat --settings\` for full analysis.`);
    }
  } catch {
    // Advisory is best-effort — never fail the install
  }
}

async function installCommand(
  source: string,
  options: InstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const sourcePath = safePath.resolve(source);

    // Validate source path exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument
    if (!existsSync(sourcePath)) {
      throw new Error(`Source path not found: ${sourcePath}`);
    }

    // Check it is a directory
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path
    const stat = lstatSync(sourcePath);
    if (!stat.isDirectory()) {
      throw new Error(`Source must be a directory: ${sourcePath}`);
    }

    // Determine resource type
    const resourceType = options.type ?? detectResourceType(sourcePath);
    logger.debug(`Resource type: ${resourceType}`);

    // When --type is provided by the user, validate the structure matches
    if (options.type) {
      validateResourceStructure(sourcePath, options.type);
    }

    // Determine install directory
    const installDir = resolveInstallDir(resourceType, options);

    // Determine resource name (use --name override or directory basename)
    const resourceName = options.name ?? basename(sourcePath);

    // Prepare install path
    const { installPath, alreadyExists } = await prepareInstallPath(installDir, resourceName, options);

    if (!options.dryRun) {
      logger.info(`Installing ${resourceName}...`);
      cpSync(sourcePath, installPath, { recursive: true, force: true });
    }

    const duration = Date.now() - startTime;
    outputSuccess({
      resourceName,
      installPath,
      source: `local:${sourcePath}`,
      resourceType,
      duration,
      options,
      logger,
      alreadyExists,
    });

    // Post-install advisory: check for settings conflicts (best-effort, advisory only)
    // Skip in dry-run mode and when --no-compat-check is used
    if (!options.dryRun && options.compatCheck !== false) {
      await runPostInstallSettingsAdvisory(installPath, logger);
    }

    process.exit(0);
  } catch (error) {
    if (error instanceof InstallError) {
      // Expected failure — exit 1 (user-fixable)
      const duration = Date.now() - startTime;
      logger.error(`Install failed: ${error.message}`);
      writeYamlOutput({
        status: 'error',
        error: error.message,
        duration: `${duration}ms`,
      });
      process.exit(1);
    }
    handleCommandError(error, logger, startTime, 'Install');
  }
}

/**
 * Create the unified install command.
 * Top-level command: vat install <source>
 */
export function createInstallCommand(): Command {
  const command = new Command('install');

  const { skillsDir, pluginsDir, marketplacesDir } = getClaudeUserPaths();

  command
    .description('Install a resource (agent skill, plugin, or marketplace) to Claude Code')
    .argument('<source>', 'Local directory to install from')
    .option(
      '--type <type>',
      'Override auto-detected resource type (agent-skill | claude-plugin | claude-marketplace)'
    )
    .option('-s, --skills-dir <path>', 'Claude skills directory', skillsDir)
    .option('-p, --plugins-dir <path>', 'Claude plugins directory', pluginsDir)
    .option('-m, --marketplaces-dir <path>', 'Claude marketplaces directory', marketplacesDir)
    .option('-n, --name <name>', 'Custom name for the installed resource (default: directory name)')
    .option('-f, --force', 'Overwrite existing installation', false)
    .option('--dry-run', 'Preview installation without creating files', false)
    .option('--no-compat-check', 'Skip post-install settings compatibility advisory')
    .option('--debug', 'Enable debug logging')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs a resource to the correct Claude Code directory. Automatically detects
  the resource type from the directory structure and routes to the appropriate
  ~/.claude/ subdirectory.

  Supported resource types:
  - agent-skill        (SKILL.md at root)                  → ~/.claude/skills/
  - claude-plugin      (.claude-plugin/plugin.json)        → ~/.claude/plugins/
  - claude-marketplace (.claude-plugin/marketplace.json)   → ~/.claude/marketplaces/

  Use --type to override auto-detection when needed.

Output:
  - status: success/error
  - sourceType: detected/specified resource type
  - name: name of installed resource
  - installPath: where the resource was installed
  - duration: time taken

Exit Codes:
  0 - Installation successful
  1 - Installation error (invalid source, resource exists without --force, etc.)
  2 - System error

Example:
  $ vat install ./my-skill/              # Auto-detect type and install
  $ vat install ./my-plugin/ --force    # Overwrite existing installation
  $ vat install ./my-skill/ --dry-run   # Preview without creating files
`
    );

  return command;
}
