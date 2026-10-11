/**
 * `vat claude org invites` — manage organization invites via Admin API.
 */
import { Command } from 'commander';

import { endWithRefusal, NOTHING_FINISHED } from '../../../utils/document-writer.js';

import { addPaginationOptions, buildPaginationParams, executeOrgCommand } from './helpers.js';
import { NOT_IMPLEMENTED_MESSAGE } from './stubs.js';

interface OrgInvite {
  id: string;
  type: string;
  email: string;
  role: string;
  invited_at: string;
  expires_at: string;
  status: string;
}

interface InvitesListResponse {
  data: OrgInvite[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export function createOrgInvitesCommand(): Command {
  const command = new Command('invites');

  command
    .description('Manage organization invites')
    .helpCommand(false);

  // list
  const listCmd = new Command('list');
  addPaginationOptions(listCmd.description('List organization invites'))
    .action(async (options: { limit?: string; afterId?: string; debug?: boolean }) => {
      await executeOrgCommand('claude org invites list', options.debug, async ({ client }) => {
        const params = buildPaginationParams(options);
        const resp = await client.get<InvitesListResponse>('/v1/organizations/invites', params);
        return {
          has_more: resp.has_more,
          data: resp.data.map((inv) => ({
            id: inv.id, type: inv.type, email: inv.email, role: inv.role,
            invited_at: inv.invited_at, expires_at: inv.expires_at, status: inv.status,
          })),
        };
      });
    })
    .addHelpText('after', `
Description:
  Lists pending and expired invites in the organization.

Example:
  $ vat claude org invites list
`);

  // create (stub)
  const createCmd = new Command('create');
  createCmd
    .description('Create an invite (not yet implemented)')
    .requiredOption('--email <email>', 'Email address to invite')
    .requiredOption('--role <role>', 'Role for the invitee (user, developer, admin)')
    .action(() => {
      endWithRefusal('claude org invites create', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  // delete (stub)
  const deleteCmd = new Command('delete');
  deleteCmd
    .description('Delete an invite (not yet implemented)')
    .argument('<invite-id>', 'Invite ID')
    .action(() => {
      endWithRefusal('claude org invites delete', 'NOT_IMPLEMENTED', NOT_IMPLEMENTED_MESSAGE, 'yaml', { strict: false }, NOTHING_FINISHED);
    });

  command.addCommand(listCmd);
  command.addCommand(createCmd);
  command.addCommand(deleteCmd);

  return command;
}
