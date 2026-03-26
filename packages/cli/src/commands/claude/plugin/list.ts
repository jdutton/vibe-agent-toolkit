// packages/cli/src/commands/claude/plugin/list.ts
import { getClaudeUserPaths, listLocalPlugins } from '@vibe-agent-toolkit/claude-marketplace';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';

import { writeYamlHeader } from './helpers.js';

interface PluginListCommandOptions {
  target?: string;
  debug?: boolean;
}

export function createPluginListCommand(): Command {
  const command = new Command('list');

  command
    .description('List installed skill packages in Claude Code')
    .option('--target <target>', 'Target surface: code (default)', 'code')
    .option('--debug', 'Enable debug logging')
    .action(pluginListCommand)
    .addHelpText('after', `
Description:
  Lists all skill packages installed in Claude Code (default: local ~/.claude/).
  Shows both plugin-registry installs and legacy skills directory entries.

Output:
  - status: success
  - target: code
  - sources.pluginRegistry: count from installed_plugins.json
  - sources.legacySkillsDir: count from ~/.claude/skills/
  - plugins[]: plugin-registry entries
  - legacySkills[]: legacy skills directory entries

Exit Codes:
  0 - List successful
  2 - System error

Example:
  $ vat claude plugin list          # List locally installed plugins
`);

  return command;
}

async function pluginListCommand(options: PluginListCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const target = options.target ?? 'code';

    if (target !== 'code') {
      // Write separator directly — cannot use writeYamlHeader() which outputs status: success
      process.stdout.write(`---\n`);
      process.stdout.write(`target: ${target}\n`);
      process.stdout.write(`status: not-available\n`);
      process.stdout.write(`reason: "Only --target code is supported in this version"\n`);
      process.exit(1);
    }

    const paths = getClaudeUserPaths();
    const result = listLocalPlugins(paths);

    writeYamlHeader();
    process.stdout.write(`target: code\n`);
    process.stdout.write(`sources:\n`);
    process.stdout.write(`  pluginRegistry: ${result.pluginRegistry}\n`);
    process.stdout.write(`  legacySkillsDir: ${result.legacySkillsDir}\n`);
    process.stdout.write(`plugins:\n`);
    for (const plugin of result.plugins) {
      process.stdout.write(`  - name: ${plugin.name}\n`);
      process.stdout.write(`    marketplace: ${plugin.marketplace}\n`);
      process.stdout.write(`    version: ${plugin.version}\n`);
      process.stdout.write(`    installedAt: ${plugin.installedAt}\n`);
      process.stdout.write(`    source: ${plugin.source}\n`);
    }
    if (result.legacySkills.length > 0) {
      process.stdout.write(`legacySkills:\n`);
      for (const skill of result.legacySkills) {
        process.stdout.write(`  - name: ${skill.name}\n`);
        process.stdout.write(`    path: ${skill.path}\n`);
        process.stdout.write(`    type: ${skill.type}\n`);
      }
    }
    process.stdout.write(`duration: ${Date.now() - startTime}ms\n`);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'PluginList');
  }
}
