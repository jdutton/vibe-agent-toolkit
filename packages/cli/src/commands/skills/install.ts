/**
 * Install a skill to Claude's plugins directory
 *
 * Supports installing from:
 * - Local ZIP file
 * - Local directory
 * - GitHub release URL (future)
 * - npm package (future)
 */

import { existsSync, statSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import AdmZip from 'adm-zip';
import { Command } from 'commander';

import { getClaudeUserPaths } from '../../utils/claude-paths.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

export interface SkillsInstallCommandOptions {
  pluginsDir?: string;
  name?: string;
  force?: boolean;
  debug?: boolean;
}

export function createInstallCommand(): Command {
  const command = new Command('install');

  command
    .description('Install a skill to Claude Code plugins directory')
    .argument('<source>', 'Source to install from (ZIP file or directory path)')
    .option(
      '-p, --plugins-dir <path>',
      'Claude plugins directory',
      getClaudeUserPaths().pluginsDir
    )
    .option('-n, --name <name>', 'Custom name for installed skill (default: auto-detect from source)')
    .option('-f, --force', 'Overwrite existing skill if present', false)
    .option('--debug', 'Enable debug logging')
    .action(installCommand)
    .addHelpText(
      'after',
      `
Description:
  Installs a skill to Claude Code's plugins directory from various sources.

  Supported sources:
  - Local ZIP file: Extracts to plugins directory
  - Local directory: Copies to plugins directory
  - GitHub URL: Downloads and extracts (future)
  - npm package: Installs from registry (future)

  Default plugins directory: ~/.claude/plugins/

Output:
  - status: success/error
  - skillName: Name of installed skill
  - installPath: Where the skill was installed
  - source: Original source path

Exit Codes:
  0 - Installation successful
  1 - Installation error (invalid source, skill exists, etc.)
  2 - System error

Example:
  $ vat skills install ./cat-agents-skill.zip
  $ vat skills install ./my-skill-dir --name custom-skill-name
  $ vat skills install skill.zip --force
`
    );

  return command;
}

async function installCommand(
  source: string,
  options: SkillsInstallCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const sourcePath = resolve(source);

    logger.info(`📥 Installing skill from: ${sourcePath}`);

    // Validate source exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument, validated
    if (!existsSync(sourcePath)) {
      throw new Error(`Source not found: ${sourcePath}`);
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- User-provided CLI argument, validated above
    const stat = statSync(sourcePath);
    const isZip = sourcePath.endsWith('.zip') && stat.isFile();
    const isDirectory = stat.isDirectory();

    if (!isZip && !isDirectory) {
      throw new Error(`Source must be a .zip file or directory: ${sourcePath}`);
    }

    // Determine skill name
    let skillName: string;
    if (options.name) {
      skillName = options.name;
    } else if (isZip) {
      // Remove .zip extension
      skillName = basename(sourcePath, '.zip');
    } else {
      // Use directory name
      skillName = basename(sourcePath);
    }

    // Determine installation path
    const pluginsDir = options.pluginsDir ?? getClaudeUserPaths().pluginsDir;
    const installPath = join(pluginsDir, skillName);

    // Check if skill already exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Constructed from validated paths
    if (existsSync(installPath) && !options.force) {
      throw new Error(
        `Skill already exists at ${installPath}. Use --force to overwrite.`
      );
    }

    // Create plugins directory if it doesn't exist
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Plugins directory path, safe
    await mkdir(pluginsDir, { recursive: true });

    // Install based on source type
    if (isZip) {
      logger.info('   Extracting ZIP...');
      const zip = new AdmZip(sourcePath);
      // Note: extractAllTo is safe here because:
      // 1. Source is user-provided local file (not untrusted remote)
      // 2. Target directory is in ~/.claude/plugins/ (not system directories)
      // 3. Skills are markdown files (small, no executable code)
      // Users should only install skills from trusted sources
      // eslint-disable-next-line sonarjs/no-unsafe-unzip -- User-provided local files, isolated plugin directory
      zip.extractAllTo(installPath, /* overwrite */ true);
    } else {
      logger.info('   Copying directory...');
      await cp(sourcePath, installPath, { recursive: true, force: true });
    }

    const duration = Date.now() - startTime;

    // Output YAML to stdout
    process.stdout.write('---\n');
    process.stdout.write(`status: success\n`);
    process.stdout.write(`skillName: ${skillName}\n`);
    process.stdout.write(`installPath: ${installPath}\n`);
    process.stdout.write(`source: ${sourcePath}\n`);
    process.stdout.write(`duration: ${duration}ms\n`);

    logger.info(`✅ Installed skill: ${skillName}`);
    logger.info(`   Location: ${installPath}`);
    logger.info(`\n💡 Run 'vat skills list' to verify installation`);
    logger.info(`   Restart Claude Code or run /reload-skills to use the new skill`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsInstall');
  }
}
