/**
 * Uninstall skills from Claude's skills directory
 *
 * Supports:
 * - Single skill by name: vat skills uninstall <name>
 * - All skills from package: vat skills uninstall --all
 * - Dry-run preview: --dry-run
 */

import { lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getClaudeUserPaths } from '../../utils/claude-paths.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

import { readPackageJsonVatMetadata, writeYamlHeader } from './install-helpers.js';

interface SkillsUninstallOptions {
  skillsDir?: string;
  all?: boolean;
  dryRun?: boolean;
  debug?: boolean;
}

export function createUninstallCommand(): Command {
  const command = new Command('uninstall');

  command
    .description('Uninstall skills from Claude Code skills directory')
    .argument('[name]', 'Name of skill to uninstall')
    .option(
      '-s, --skills-dir <path>',
      'Claude skills directory',
      getClaudeUserPaths().skillsDir
    )
    .option('-a, --all', 'Uninstall all skills declared in package.json vat.skills[]', false)
    .option('--dry-run', 'Preview uninstall without removing files', false)
    .option('--debug', 'Enable debug logging')
    .action(uninstallCommand)
    .addHelpText(
      'after',
      `
Description:
  Removes installed skills from Claude Code's skills directory.
  Detects and handles both symlinks (dev installs) and copied directories.

  Single skill: vat skills uninstall my-skill
  All from package: vat skills uninstall --all (reads package.json vat.skills[])

Output:
  - status: success/error
  - skillsRemoved: number of skills removed
  - skills: array with name, path, wasSymlink for each

Exit Codes:
  0 - Uninstall successful
  1 - Skill not found or not installed
  2 - System error

Example:
  $ vat skills uninstall my-skill          # Remove single skill
  $ vat skills uninstall --all             # Remove all package skills
  $ vat skills uninstall --all --dry-run   # Preview removal
`
    );

  return command;
}

async function uninstallCommand(
  name: string | undefined,
  options: SkillsUninstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Determine which skills to uninstall
    const skillNames = await resolveSkillNames(name, options, logger);
    const skillsDir = options.skillsDir ?? getClaudeUserPaths().skillsDir;

    const removed: Array<{ name: string; path: string; wasSymlink: boolean }> = [];

    for (const skillName of skillNames) {
      const result = await removeSkill(skillName, skillsDir, options.dryRun ?? false, logger);
      if (result) {
        removed.push(result);
      }
    }

    if (removed.length === 0) {
      logger.error('No skills were removed');
      process.exit(1);
    }

    const duration = Date.now() - startTime;
    outputUninstallSuccess(removed, duration, logger, options.dryRun);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsUninstall');
  }
}

/**
 * Resolve skill names from argument or --all flag
 */
async function resolveSkillNames(
  name: string | undefined,
  options: SkillsUninstallOptions,
  logger: ReturnType<typeof createLogger>
): Promise<string[]> {
  if (options.all) {
    const cwd = process.cwd();
    const { packageJson, skills } = await readPackageJsonVatMetadata(cwd);
    logger.info(`📦 Uninstalling all skills from ${packageJson.name}`);
    return skills.map(s => s.name);
  }

  if (!name) {
    throw new Error(
      'Skill name required. Usage:\n' +
        '  vat skills uninstall <name>       # Remove single skill\n' +
        '  vat skills uninstall --all        # Remove all from package.json'
    );
  }

  return [name];
}

/**
 * Remove a single skill from the skills directory
 * Uses lstatSync to detect symlinks (doesn't follow them)
 */
async function removeSkill(
  name: string,
  skillsDir: string,
  dryRun: boolean,
  logger: ReturnType<typeof createLogger>
): Promise<{ name: string; path: string; wasSymlink: boolean } | undefined> {
  const skillPath = join(skillsDir, name);

  // Check if installed (lstatSync detects broken symlinks)
  let wasSymlink = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Skills dir from config
    const stat = lstatSync(skillPath);
    wasSymlink = stat.isSymbolicLink();
  } catch {
    logger.error(`   ⚠️  ${name}: not installed at ${skillPath}`);
    return undefined;
  }

  const typeLabel = wasSymlink ? 'symlink' : 'directory';

  if (dryRun) {
    logger.info(`   Would remove ${typeLabel}: ${name} (${skillPath})`);
  } else {
    await rm(skillPath, { recursive: true, force: true });
    logger.info(`   Removed ${typeLabel}: ${name}`);
  }

  return { name, path: skillPath, wasSymlink };
}

/**
 * Output success YAML for uninstall
 */
function outputUninstallSuccess(
  removed: Array<{ name: string; path: string; wasSymlink: boolean }>,
  duration: number,
  logger: ReturnType<typeof createLogger>,
  dryRun?: boolean
): void {
  writeYamlHeader(dryRun);
  process.stdout.write(`skillsRemoved: ${removed.length}\n`);
  process.stdout.write(`skills:\n`);
  for (const skill of removed) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    path: ${skill.path}\n`);
    process.stdout.write(`    wasSymlink: ${skill.wasSymlink}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);

  if (dryRun) {
    logger.info(`\n✅ Dry-run: ${removed.length} skill(s) would be removed`);
  } else {
    logger.info(`\n✅ Removed ${removed.length} skill(s)`);
  }
}
