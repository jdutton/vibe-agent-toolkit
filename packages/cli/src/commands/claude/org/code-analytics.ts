/**
 * `vat claude org code-analytics` — Claude Code metrics via Admin API.
 */
import { Command } from 'commander';

import { autopaginateReport, defaultDaysAgoDateOnly, executeOrgCommand } from './helpers.js';

export function createOrgCodeAnalyticsCommand(): Command {
  const command = new Command('code-analytics');

  command
    .description('Fetch Claude Code metrics')
    .option('--from <date>', 'Start date YYYY-MM-DD (default: 30 days ago)')
    .option('--debug', 'Enable debug logging')
    .action(async (options: { from?: string; debug?: boolean }) => {
      await executeOrgCommand('OrgCodeAnalytics', options.debug, async ({ client }) => {
        return autopaginateReport(client, '/v1/organizations/usage_report/claude_code', {
          starting_at: options.from ?? defaultDaysAgoDateOnly(30),
        });
      });
    })
    .addHelpText('after', `
Description:
  Fetches Claude Code metrics from the Admin API. Autopaginates.
  Returns empty array when no Code seats are active.
  Note: only --from is supported (no --to); the API has no ending_at param.

Example:
  $ vat claude org code-analytics --from 2025-01-01
`);

  return command;
}
