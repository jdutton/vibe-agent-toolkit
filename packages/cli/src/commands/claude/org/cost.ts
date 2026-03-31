/**
 * `vat claude org cost` — USD cost report via Admin API.
 *
 * Uses URLSearchParams for group_by[] repeated params.
 * Paginates by advancing starting_at (API rejects next_page as query param).
 */
import { Command } from 'commander';

import { defaultFirstOfMonth, executeOrgCommand } from './helpers.js';

interface CostBucket {
  starting_at: string;
  ending_at: string;
  results: Array<{ amount: string; [key: string]: unknown }>;
}

interface CostResponse {
  data: CostBucket[];
  has_more: boolean;
  next_page: string | null;
}

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
        await executeOrgCommand('OrgCost', options.debug, async ({ client }) => {
          let startingAt = options.from ?? defaultFirstOfMonth();
          const endingAt = options.to ?? new Date().toISOString();
          const allData: CostBucket[] = [];

          let hasMore = true;
          while (hasMore) {
            const urlParams = new URLSearchParams();
            urlParams.set('starting_at', startingAt);
            urlParams.set('ending_at', endingAt);

            if (options.groupBy) {
              for (const field of options.groupBy.split(',')) {
                urlParams.append('group_by[]', field.trim());
              }
            }

            const path = `/v1/organizations/cost_report?${urlParams.toString()}`;
            const resp = await client.get<CostResponse>(path);
            allData.push(...resp.data);

            if (!resp.has_more || resp.data.length === 0) {
              hasMore = false;
            } else {
              // Advance starting_at to last bucket's ending_at for next page
              const lastBucket = resp.data.at(-1);
              if (lastBucket) {
                startingAt = lastBucket.ending_at;
              } else {
                hasMore = false;
              }
            }
          }

          return { count: allData.length, data: allData };
        });
      },
    )
    .addHelpText('after', `
Description:
  Fetches USD cost report from the Admin API. Autopaginates.
  Note: amount is a string (not a number) in the API response.

Output:
  - status: success
  - count: number of cost entries
  - data[]: array of cost entries with amount as string

Example:
  $ vat claude org cost --group-by description,workspace
`);

  return command;
}
