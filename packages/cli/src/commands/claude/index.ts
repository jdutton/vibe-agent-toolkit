// packages/cli/src/commands/claude/index.ts
/**
 * Claude command group — gateway to the Claude ecosystem.
 *
 * Local plugin management: vat claude plugin install/list/uninstall
 * Org administration:      vat claude org ... (coming in this release)
 */

import { Command } from 'commander';

import { createOrgCommand } from './org/index.js';
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
  Org administration: manage users, workspaces, API keys, and usage via Admin API

Examples:
  $ vat claude plugin install npm:@myorg/my-skills    # Install from npm
  $ vat claude plugin list                            # List installed plugins
  $ vat claude org info                               # Show org details
  $ vat claude org users list                         # List org users
  $ vat claude org usage --from 2025-01-01T00:00:00Z  # Token usage report
`);

  command.addCommand(createPluginCommand());
  command.addCommand(createOrgCommand());

  return command;
}
