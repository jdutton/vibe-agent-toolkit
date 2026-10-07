/**
 * `vat claude org cost` — USD cost report via Admin API.
 *
 * Uses URLSearchParams for group_by[] repeated params.
 * Paginates by advancing starting_at (API rejects next_page as query param).
 */
import { Command } from 'commander';

import { autopaginateReport, defaultFirstOfMonth, executeOrgCommand } from './helpers.js';

export function createOrgCostCommand(): Command {
  const command = new Command('cost');

  command
    .description('Fetch USD cost report')
    .option('--from <datetime>', 'Start datetime (ISO 8601, default: first of month)')
    .option('--to <datetime>', 'End datetime (ISO 8601, default: now)')
    .option('--group-by <fields>', 'Comma-separated grouping fields (description, workspace)')
    .option('--debug', 'Enable debug logging')
    .action(
      async (options: { from?: string; to?: string; groupBy?: string; debug?: boolean }) => {
        await executeOrgCommand('claude org cost', options.debug, ({ client }) => {
          // group_by[] repeats, which QueryParams cannot express, so it rides in the path.
          const groupBy = new URLSearchParams();
          for (const field of options.groupBy ? options.groupBy.split(',') : []) {
            groupBy.append('group_by[]', field.trim());
          }
          const query = groupBy.size > 0 ? `?${groupBy.toString()}` : '';
          return autopaginateReport(client, `/v1/organizations/cost_report${query}`, {
            starting_at: options.from ?? defaultFirstOfMonth(),
            ending_at: options.to ?? new Date().toISOString(),
          });
        });
      },
    )
    .addHelpText('after', `
Description:
  Fetches USD cost report from the Admin API. Autopaginates.
  Note: amount is a string (not a number) in the API response.

Output:
  - count: number of cost entries
  - data[]: array of cost entries with amount as string

Example:
  $ vat claude org cost --group-by description,workspace
`);

  return command;
}
