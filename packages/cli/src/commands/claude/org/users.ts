/**
 * `vat claude org users` — manage organization users via Admin API.
 */
import { Command } from 'commander';

import { addPaginationOptions, buildPaginationParams, executeOrgCommand } from './helpers.js';
import { writeNotYetImplementedStub } from './stubs.js';

interface OrgUser {
  id: string;
  type: string;
  email: string;
  name: string;
  role: string;
  added_at: string;
}

interface UsersListResponse {
  data: OrgUser[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export function createOrgUsersCommand(): Command {
  const command = new Command('users');

  command
    .description('Manage organization users')
    .helpCommand(false);

  // list
  const listCmd = new Command('list');
  addPaginationOptions(listCmd.description('List organization users'))
    .action(async (options: { limit?: string; afterId?: string; debug?: boolean }) => {
      await executeOrgCommand('OrgUsersList', options.debug, async ({ client }) => {
        const params = buildPaginationParams(options);
        const resp = await client.get<UsersListResponse>('/v1/organizations/users', params);
        return {
          has_more: resp.has_more,
          data: resp.data.map((u) => ({
            id: u.id, type: u.type, email: u.email, name: u.name, role: u.role, added_at: u.added_at,
          })),
        };
      });
    })
    .addHelpText('after', `
Description:
  Lists users in the organization. Supports pagination.

Example:
  $ vat claude org users list --limit 50
`);

  // get
  const getCmd = new Command('get');
  getCmd
    .description('Get a single user by ID')
    .argument('<user-id>', 'User ID')
    .option('--debug', 'Enable debug logging')
    .action(async (userId: string, options: { debug?: boolean }) => {
      await executeOrgCommand('OrgUsersGet', options.debug, async ({ client }) => {
        return client.get<OrgUser>(`/v1/organizations/users/${userId}`);
      });
    })
    .addHelpText('after', `
Example:
  $ vat claude org users get user_abc123
`);

  // update (stub)
  const updateCmd = new Command('update');
  updateCmd
    .description('Update a user role (not yet implemented)')
    .argument('<user-id>', 'User ID')
    .requiredOption('--role <role>', 'New role (user, developer, admin)')
    .action(() => {
      writeNotYetImplementedStub('org users update');
      process.exit(1);
    });

  // remove (stub)
  const removeCmd = new Command('remove');
  removeCmd
    .description('Remove a user from the organization (not yet implemented)')
    .argument('<user-id>', 'User ID')
    .action(() => {
      writeNotYetImplementedStub('org users remove');
      process.exit(1);
    });

  command.addCommand(listCmd);
  command.addCommand(getCmd);
  command.addCommand(updateCmd);
  command.addCommand(removeCmd);

  return command;
}
