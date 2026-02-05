/**
 * List installed skills
 *
 * Shows all skills currently installed in Claude's plugins directory
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { extractH1Title } from '@vibe-agent-toolkit/agent-skills';
import { parseMarkdown } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

export interface SkillsListCommandOptions {
  pluginsDir?: string;
  verbose?: boolean;
  debug?: boolean;
}

interface InstalledSkill {
  name: string;
  path: string;
  hasSkillMd: boolean;
  title?: string;
  description?: string;
}

export function createListCommand(): Command {
  const command = new Command('list');

  command
    .description('List installed skills in Claude Code plugins directory')
    .option(
      '-p, --plugins-dir <path>',
      'Claude plugins directory',
      join(homedir(), '.claude', 'plugins')
    )
    .option('-v, --verbose', 'Show detailed skill information', false)
    .option('--debug', 'Enable debug logging')
    .action(listCommand)
    .addHelpText(
      'after',
      `
Description:
  Lists all skills currently installed in Claude Code's plugins directory.
  Scans for directories containing SKILL.md files and extracts metadata.

  Default plugins directory: ~/.claude/plugins/

Output:
  - status: success/error
  - pluginsDir: Path to plugins directory
  - skillsFound: Number of skills discovered
  - skills: Array of skill objects with name, path, and metadata

Exit Codes:
  0 - List operation successful
  1 - Error listing skills
  2 - System error

Example:
  $ vat skills list
  $ vat skills list --verbose
`
    );

  return command;
}

/**
 * Extract skill metadata from SKILL.md
 */
async function extractSkillMetadata(
  skillMdPath: string,
  skillName: string,
  logger: ReturnType<typeof createLogger>
): Promise<{ title?: string; description?: string }> {
  try {
    const parseResult = await parseMarkdown(skillMdPath);

    // Try to get title from frontmatter or H1
    let title: string | undefined;
    if (parseResult.frontmatter?.['name']) {
      title = parseResult.frontmatter['name'] as string;
    } else {
      // Extract H1 title
      title = extractH1Title(parseResult.content);
    }

    // Get description from frontmatter
    const description = parseResult.frontmatter?.['description'] as string | undefined;

    // Build result with only defined properties (exactOptionalPropertyTypes)
    const result: { title?: string; description?: string } = {};
    if (title !== undefined) {
      result.title = title;
    }
    if (description !== undefined) {
      result.description = description;
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.debug(`Failed to parse SKILL.md for ${skillName}: ${errorMessage}`);
    return {};
  }
}

/**
 * Output skills as YAML
 */
function outputSkillsYaml(
  pluginsDir: string,
  skills: InstalledSkill[],
  duration: number,
  options: SkillsListCommandOptions
): void {
  process.stdout.write('---\n');
  process.stdout.write(`status: success\n`);
  process.stdout.write(`pluginsDir: ${pluginsDir}\n`);
  process.stdout.write(`skillsFound: ${skills.length}\n`);
  process.stdout.write(`skills:\n`);

  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    path: ${skill.path}\n`);
    process.stdout.write(`    hasSkillMd: ${skill.hasSkillMd}\n`);

    if (options.verbose && skill.title) {
      process.stdout.write(`    title: ${skill.title}\n`);
    }

    if (options.verbose && skill.description) {
      process.stdout.write(`    description: ${skill.description}\n`);
    }
  }

  process.stdout.write(`duration: ${duration}ms\n`);
}

/**
 * Output human-readable skill list
 */
function outputSkillsHuman(
  skills: InstalledSkill[],
  logger: ReturnType<typeof createLogger>,
  options: SkillsListCommandOptions
): void {
  if (skills.length === 0) {
    logger.info(`\n   No skills found`);
    return;
  }

  logger.info(`\n   Found ${skills.length} skill${skills.length === 1 ? '' : 's'}:\n`);

  for (const skill of skills) {
    const status = skill.hasSkillMd ? '✓' : '⚠';
    const title = skill.title ?? skill.name;

    if (options.verbose && skill.description) {
      logger.info(`   ${status} ${title}`);
      logger.info(`      ${skill.description}`);
      logger.info(`      ${skill.path}\n`);
    } else {
      logger.info(`   ${status} ${title}`);
    }
  }
}

async function listCommand(options: SkillsListCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const pluginsDir = options.pluginsDir ?? join(homedir(), '.claude', 'plugins');

    logger.info(`📋 Listing skills in: ${pluginsDir}`);

    // Check if plugins directory exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Plugins directory path, safe
    if (!existsSync(pluginsDir)) {
      logger.info(`   Plugins directory not found (no skills installed)`);

      // Output YAML
      process.stdout.write('---\n');
      process.stdout.write(`status: success\n`);
      process.stdout.write(`pluginsDir: ${pluginsDir}\n`);
      process.stdout.write(`skillsFound: 0\n`);
      process.stdout.write(`skills: []\n`);

      process.exit(0);
    }

    // Scan plugins directory for skill directories
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Plugins directory path, safe
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const skills: InstalledSkill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillPath = join(pluginsDir, entry.name);
      const skillMdPath = join(skillPath, 'SKILL.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Skill path from plugins directory
      const hasSkillMd = existsSync(skillMdPath);

      const skill: InstalledSkill = {
        name: entry.name,
        path: skillPath,
        hasSkillMd,
      };

      // Extract metadata if SKILL.md exists
      if (hasSkillMd) {
        const metadata = await extractSkillMetadata(skillMdPath, entry.name, logger);
        // Only assign if defined (exactOptionalPropertyTypes)
        if (metadata.title !== undefined) {
          skill.title = metadata.title;
        }
        if (metadata.description !== undefined) {
          skill.description = metadata.description;
        }
      }

      skills.push(skill);
    }

    const duration = Date.now() - startTime;

    // Output YAML to stdout
    outputSkillsYaml(pluginsDir, skills, duration, options);

    // Human-friendly output to stderr
    outputSkillsHuman(skills, logger, options);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsList');
  }
}
