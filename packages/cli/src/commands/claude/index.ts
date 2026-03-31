// packages/cli/src/commands/claude/index.ts
/**
 * Claude command group — gateway to the Claude ecosystem.
 *
 * Local plugin management: vat claude plugin install/list/uninstall
 * Org administration:      vat claude org ... (coming in this release)
 */

import { Command } from 'commander';

import { createPluginCommand } from './plugin/index.js';

export function createClaudeCommand(): Command {
  const command = new Command('claude');

  command
    .description('Manage Claude Code plugins and org administration')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Gateway to the Claude ecosystem — local plugin management and org administration.

  Plugin management: install, list, and uninstall skill packages in ~/.claude/
  Org administration: manage users, workspaces, API keys, and usage (coming soon)

Examples:
  $ vat claude plugin install npm:@myorg/my-skills    # Install from npm
  $ vat claude plugin install --npm-postinstall       # From npm postinstall hook
  $ vat claude plugin list                            # List installed plugins
  $ vat claude plugin uninstall my-skill@my-market   # Remove a plugin
`);

  command.addCommand(createPluginCommand());

  return command;
}
