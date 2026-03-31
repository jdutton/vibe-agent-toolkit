/**
 * `vat claude org usage` — daily token usage report via Admin API.
 */
import { Command } from 'commander';

import { autopaginateReport, defaultDaysAgo, executeOrgCommand } from './helpers.js';

export function createOrgUsageCommand(): Command {
  const command = new Command('usage');

  command
    .description('Fetch daily token usage report')
    .option('--from <datetime>', 'Start datetime (ISO 8601, default: 30 days ago)')
    .option('--to <datetime>', 'End datetime (ISO 8601, default: now)')
    .option('--debug', 'Enable debug logging')
    .action(async (options: { from?: string; to?: string; debug?: boolean }) => {
      await executeOrgCommand('OrgUsage', options.debug, async ({ client }) => {
        return autopaginateReport(client, '/v1/organizations/usage_report/messages', {
          starting_at: options.from ?? defaultDaysAgo(30),
          ending_at: options.to ?? new Date().toISOString(),
        });
      });
    })
    .addHelpText('after', `
Description:
  Fetches daily token usage buckets from the Admin API. Autopaginates.

Output:
  - status: success
  - count: number of usage buckets
  - data[]: array of { starting_at, ending_at, results }

Example:
  $ vat claude org usage --from 2025-01-01T00:00:00Z --to 2025-01-31T23:59:59Z
`);

  return command;
}
