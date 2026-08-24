// packages/cli/src/commands/claude/index.ts
/**
 * Claude command group — gateway to the Claude ecosystem.
 *
 * Local plugin management: vat claude plugin install/list/uninstall
 * Org administration:      vat claude org ... (coming in this release)
 * Context analysis:        vat claude context <path>, vat claude budget [paths]
 *
 * `context` and `budget` are the group's ANALYSIS verbs — they answer questions
 * about a tree and change nothing — where every other member manages something.
 * Named as such in the group's help rather than left to hide among the
 * management verbs, because a reader scanning for "what does Claude Code load
 * here" will not think to look under a plugin-management heading.
 *
 * The two are deliberately separate: `context` QUERIES (totals, admissions, the
 * declared limits, no verdict, always exit 0) and `budget` CHECKS (findings,
 * configurable severity, an exit code an adopter can make gate). Folding the
 * verdict into the query would make the query's number one people learn to stop
 * reading.
 */

import { Command } from 'commander';

import { createBudgetCommand } from './budget.js';
import { createContextCommand } from './context.js';
import { createMarketplaceCommand } from './marketplace/index.js';
import { createOrgCommand } from './org/index.js';
import { createPluginCommand } from './plugin/index.js';

export function createClaudeCommand(): Command {
  const command = new Command('claude');

  command
    .description('Manage Claude Code plugins and marketplaces, administer an org, analyze context')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Gateway to the Claude ecosystem — plugin management, marketplaces, org
  administration, and context analysis.

  Plugin management: install, list, and uninstall skill packages in ~/.claude/
  Marketplace:       validate and publish marketplace directories
  Org administration: manage users, workspaces, API keys, and usage via Admin API
  Context analysis:  report what loads into an agent's context at a path, and
                     check it against a token budget (both read-only)

Examples:
  $ vat claude plugin install npm:@myorg/my-skills    # Install from npm
  $ vat claude plugin list                            # List installed plugins
  $ vat claude context packages/cli/src/index.ts      # What loads in context here
  $ vat claude budget packages/cli                    # Is that over budget?
  $ vat claude org info                               # Show org details
  $ vat claude org users list                         # List org users
  $ vat claude org usage --from 2025-01-01T00:00:00Z  # Token usage report
`);

  command.addCommand(createContextCommand());
  command.addCommand(createBudgetCommand());
  command.addCommand(createPluginCommand());
  command.addCommand(createMarketplaceCommand());
  command.addCommand(createOrgCommand());

  return command;
}
