/**
 * `vat claude org` — organization administration command group.
 *
 * Provides CLI access to the Anthropic Admin API and Skills API for managing
 * organization resources: users, invites, workspaces, API keys, usage, cost,
 * code analytics, and skills.
 */
import { Command } from 'commander';

import { createOrgApiKeysCommand } from './api-keys.js';
import { createOrgCodeAnalyticsCommand } from './code-analytics.js';
import { createOrgCostCommand } from './cost.js';
import { createOrgInfoCommand } from './info.js';
import { createOrgInvitesCommand } from './invites.js';
import { createOrgSkillsCommand } from './skills.js';
import { createOrgUsageCommand } from './usage.js';
import { createOrgUsersCommand } from './users.js';
import { createOrgWorkspacesCommand } from './workspaces.js';

export function createOrgCommand(): Command {
  const command = new Command('org');

  command
    .description('Manage your Anthropic organization (Admin API) and workspace skills (Skills API)')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Two surfaces under one group: organization administration via the Anthropic
  Admin API, and workspace skills via the Skills API.

  Each takes its OWN key, and never the other one. Set the key for the commands
  you are running; neither family needs both.

Commands and the key each requires:
  ANTHROPIC_ADMIN_API_KEY (sk-ant-admin-...)
    info              Show organization details
    users             Manage users (list, get, update, remove)
    invites           Manage invites (list, create, delete)
    workspaces        Manage workspaces and members
    api-keys          Manage API keys (list, update)
    usage             Fetch daily token usage report
    cost              Fetch USD cost report
    code-analytics    Fetch Claude Code metrics

  ANTHROPIC_API_KEY (a regular workspace key, sk-ant-api03-...)
    skills            Manage workspace skills — upload, list, version, delete.
                      The admin key is never sent to these endpoints and is not
                      needed to run them.

Exit Codes:
  0 - Success
  1 - The run happened and the outcome was not clean (e.g. skills install
      --from-npm uploaded some skills and failed others), or a stub command
  2 - The run could not happen: missing key, API failure, unusable input

Example:
  $ export ANTHROPIC_ADMIN_API_KEY=sk-ant-admin-...
  $ vat claude org info
  $ vat claude org users list
  $ vat claude org usage --from 2025-01-01T00:00:00Z
`);

  command.addCommand(createOrgInfoCommand());
  command.addCommand(createOrgUsersCommand());
  command.addCommand(createOrgInvitesCommand());
  command.addCommand(createOrgWorkspacesCommand());
  command.addCommand(createOrgApiKeysCommand());
  command.addCommand(createOrgUsageCommand());
  command.addCommand(createOrgCostCommand());
  command.addCommand(createOrgCodeAnalyticsCommand());
  command.addCommand(createOrgSkillsCommand());

  return command;
}
