/**
 * `vat claude org info` — show organization details from the Admin API.
 */
import { Command } from 'commander';

import { executeOrgCommand } from './helpers.js';

interface OrgInfoResponse {
  id: string;
  type: string;
  name: string;
}

export function createOrgInfoCommand(): Command {
  const command = new Command('info');

  command
    .description('Show organization details (id, type, name)')
    .option('--debug', 'Enable debug logging')
    .action(async (options: { debug?: boolean }) => {
      await executeOrgCommand('OrgInfo', options.debug, async ({ client }) => {
        const org = await client.get<OrgInfoResponse>('/v1/organizations/me');
        return { id: org.id, type: org.type, name: org.name };
      });
    })
    .addHelpText('after', `
Description:
  Fetches organization details from the Anthropic Admin API.
  Requires ANTHROPIC_ADMIN_API_KEY environment variable.

Output:
  - status: success
  - id: organization ID
  - type: organization type
  - name: organization name

Exit Codes:
  0 - Success
  2 - System error (missing key, API failure)

Example:
  $ vat claude org info
`);

  return command;
}
