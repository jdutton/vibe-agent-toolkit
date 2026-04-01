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
    .description('Manage your Anthropic organization (Admin API)')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Organization administration via the Anthropic Admin API.
  Requires ANTHROPIC_ADMIN_API_KEY environment variable.
  Skills commands also require ANTHROPIC_API_KEY.

Commands:
  info              Show organization details
  users             Manage users (list, get, update, remove)
  invites           Manage invites (list, create, delete)
  workspaces        Manage workspaces and members
  api-keys          Manage API keys (list, update)
  usage             Fetch daily token usage report
  cost              Fetch USD cost report
  code-analytics    Fetch Claude Code metrics
  skills            Manage organization skills

Exit Codes:
  0 - Success
  1 - Not-yet-implemented (stub commands)
  2 - System error (missing key, API failure)

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
