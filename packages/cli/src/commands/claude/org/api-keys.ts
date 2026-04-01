/**
 * `vat claude org api-keys` — manage organization API keys via Admin API.
 */
import { Command } from 'commander';

import { addPaginationOptions, buildPaginationParams, executeOrgCommand } from './helpers.js';
import { writeNotYetImplementedStub } from './stubs.js';

interface ApiKey {
  id: string;
  type: string;
  name: string;
  workspace_id: string | null;
  created_at: string;
  created_by: { id: string; type: string } | null;
  status: string;
  partially_redacted_api_key: string | null;
}

interface ApiKeysListResponse {
  data: ApiKey[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export function createOrgApiKeysCommand(): Command {
  const command = new Command('api-keys');

  command
    .description('Manage organization API keys')
    .helpCommand(false);

  // list
  const listCmd = new Command('list');
  addPaginationOptions(listCmd)
    .description('List organization API keys')
    .option('--workspace-id <id>', 'Filter by workspace ID')
    .option('--status <status>', 'Filter by status (active, inactive, archived)')
    .action(
      async (options: {
        limit?: string;
        afterId?: string;
        workspaceId?: string;
        status?: string;
        debug?: boolean;
      }) => {
        await executeOrgCommand('OrgApiKeysList', options.debug, async ({ client }) => {
          const params = buildPaginationParams(options, {
            workspace_id: options.workspaceId,
            status: options.status,
          });
          const resp = await client.get<ApiKeysListResponse>(
            '/v1/organizations/api_keys',
            params,
          );
          return { has_more: resp.has_more, data: resp.data };
        });
      },
    )
    .addHelpText('after', `
Description:
  Lists API keys in the organization. Supports filtering by workspace and status.

Example:
  $ vat claude org api-keys list --status active
`);

  // update (stub)
  const updateCmd = new Command('update');
  updateCmd
    .description('Update an API key name (not yet implemented)')
    .argument('<key-id>', 'API key ID')
    .requiredOption('--name <name>', 'New name for the API key')
    .action(() => {
      writeNotYetImplementedStub('org api-keys update');
      process.exit(1);
    });

  command.addCommand(listCmd);
  command.addCommand(updateCmd);

  return command;
}
