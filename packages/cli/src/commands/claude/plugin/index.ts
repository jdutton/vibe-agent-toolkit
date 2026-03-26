// packages/cli/src/commands/claude/plugin/index.ts
import { Command } from 'commander';

import { createPluginInstallCommand } from './install.js';
import { createPluginListCommand } from './list.js';
import { createPluginUninstallCommand } from './uninstall.js';

export function createPluginCommand(): Command {
  const command = new Command('plugin');

  command
    .description('Manage skill packages in Claude Code')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Install, list, and uninstall skill packages in Claude Code (~/.claude/).

Example:
  $ vat claude plugin install npm:@myorg/my-skills    # Install from npm
  $ vat claude plugin list                            # List installed plugins
  $ vat claude plugin uninstall my-skill@my-market   # Remove a plugin
`);

  command.addCommand(createPluginInstallCommand());
  command.addCommand(createPluginListCommand());
  command.addCommand(createPluginUninstallCommand());

  return command;
}
