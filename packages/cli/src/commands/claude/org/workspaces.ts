/**
 * `vat claude org workspaces` — manage organization workspaces via Admin API.
 */
import { Command } from 'commander';

import { endWithRefusal, NOTHING_FINISHED } from '../../../utils/document-writer.js';

import { addPaginationOptions, buildPaginationParams, executeOrgCommand } from './helpers.js';
import { NOT_IMPLEMENTED_MESSAGE } from './stubs.js';

const WS_ID_ARG = '<workspace-id>';
const WS_ID_DESC = 'Workspace ID';
const USER_ID_FLAG = '--user-id <id>';
const USER_ID_DESC = 'User ID';

interface Workspace {
  id: string;
  type: string;
  name: string;
  created_at: string;
}

interface WorkspacesListResponse {
  data: Workspace[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

interface WorkspaceMember {
  user_id: string;
  workspace_id: string;
  role: string;
  created_at: string;
}

interface WorkspaceMembersResponse {
  data: WorkspaceMember[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

function createMembersSubgroup(): Command {
  const members = new Command('members');
  members.description('Manage workspace members').helpCommand(false);

  // list
  const listCmd = new Command('list');
  addPaginationOptions(listCmd.description('List members of a workspace').argument(WS_ID_ARG, WS_ID_DESC))
    .action(
      async (
        workspaceId: string,
        options: { limit?: string; afterId?: string; debug?: boolean },
      ) => {
        await executeOrgCommand('claude org workspaces members list', options.debug, async ({ client }) => {
          const params = buildPaginationParams(options);
          // Encoded, not spliced: the id is opaque and comes straight from argv, and one
          // carrying a `/` would address a different resource.
          const resp = await client.get<WorkspaceMembersResponse>(
            `/v1/organizations/workspaces/${encodeURIComponent(workspaceId)}/members`,
            params,
          );
          return {
            has_more: resp.has_more,
            data: resp.data.map((m) => ({
              user_id: m.user_id, workspace_id: m.workspace_id,
              role: m.role, created_at: m.created_at,
            })),
          };
        });
      },
    );

  // add (stub)
  const addCmd = new Command('add');
  addCmd
    .description('Add a member to a workspace (not yet implemented)')
    .argument(WS_ID_ARG, WS_ID_DESC)
    .requiredOption(USER_ID_FLAG, USER_ID_DESC)
    .requiredOption('--role <role>', 'Role (workspace_user, workspace_developer, workspace_admin)')
    .action(() => {
      endWithRefusal('claude org workspaces members add', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  // update (stub)
  const updateCmd = new Command('update');
  updateCmd
    .description('Update a workspace member role (not yet implemented)')
    .argument(WS_ID_ARG, WS_ID_DESC)
    .requiredOption(USER_ID_FLAG, USER_ID_DESC)
    .requiredOption('--role <role>', 'New role')
    .action(() => {
      endWithRefusal('claude org workspaces members update', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  // remove (stub)
  const removeCmd = new Command('remove');
  removeCmd
    .description('Remove a member from a workspace (not yet implemented)')
    .argument(WS_ID_ARG, WS_ID_DESC)
    .requiredOption(USER_ID_FLAG, USER_ID_DESC)
    .action(() => {
      endWithRefusal('claude org workspaces members remove', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  members.addCommand(listCmd);
  members.addCommand(addCmd);
  members.addCommand(updateCmd);
  members.addCommand(removeCmd);

  return members;
}

export function createOrgWorkspacesCommand(): Command {
  const command = new Command('workspaces');

  command
    .description('Manage organization workspaces')
    .helpCommand(false);

  // list
  const listCmd = new Command('list');
  addPaginationOptions(listCmd.description('List organization workspaces'))
    .action(async (options: { limit?: string; afterId?: string; debug?: boolean }) => {
      await executeOrgCommand('claude org workspaces list', options.debug, async ({ client }) => {
        const params = buildPaginationParams(options);
        const resp = await client.get<WorkspacesListResponse>(
          '/v1/organizations/workspaces',
          params,
        );
        return {
          has_more: resp.has_more,
          data: resp.data.map((ws) => ({
            id: ws.id, type: ws.type, name: ws.name, created_at: ws.created_at,
          })),
        };
      });
    })
    .addHelpText('after', `
Description:
  Lists workspaces in the organization. Empty list is valid.

Example:
  $ vat claude org workspaces list
`);

  // get
  const getCmd = new Command('get');
  getCmd
    .description('Get a single workspace by ID')
    .argument(WS_ID_ARG, WS_ID_DESC)
    .option('--debug', 'Enable debug logging')
    .action(async (workspaceId: string, options: { debug?: boolean }) => {
      await executeOrgCommand('claude org workspaces get', options.debug, ({ client }) => {
        // Encoded, not spliced: same opaque-id-from-argv class as `skillVersionsPath`.
        return client.get<Workspace>(`/v1/organizations/workspaces/${encodeURIComponent(workspaceId)}`);
      });
    })
    .addHelpText('after', `
Example:
  $ vat claude org workspaces get ws_abc123
`);

  // create (stub)
  const createWsCmd = new Command('create');
  createWsCmd
    .description('Create a workspace (not yet implemented)')
    .requiredOption('--name <name>', 'Workspace name')
    .action(() => {
      endWithRefusal('claude org workspaces create', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  // archive (stub)
  const archiveCmd = new Command('archive');
  archiveCmd
    .description('Archive a workspace (not yet implemented)')
    .argument(WS_ID_ARG, WS_ID_DESC)
    .action(() => {
      endWithRefusal('claude org workspaces archive', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  command.addCommand(listCmd);
  command.addCommand(getCmd);
  command.addCommand(createWsCmd);
  command.addCommand(archiveCmd);
  command.addCommand(createMembersSubgroup());

  return command;
}
