/**
 * `vat claude org skills` — manage organization skills via Skills API.
 */
import { Command } from 'commander';

import { autopaginateSkills, executeOrgCommand } from './helpers.js';
import { writeNotYetImplementedStub } from './stubs.js';

const SKILL_ID_ARG = '<skill-id>';
const SKILL_ID_DESC = 'Skill ID (slug)';

export function createOrgSkillsCommand(): Command {
  const command = new Command('skills');

  command
    .description('Manage organization skills (requires ANTHROPIC_API_KEY)')
    .helpCommand(false);

  // list
  const listCmd = new Command('list');
  listCmd
    .description('List organization skills')
    .option('--debug', 'Enable debug logging')
    .action(async (options: { debug?: boolean }) => {
      await executeOrgCommand('OrgSkillsList', options.debug, async ({ client }) => {
        return autopaginateSkills(client, '/v1/skills');
      });
    })
    .addHelpText('after', `
Description:
  Lists skills in the organization. Uses the Skills API (beta).
  Requires ANTHROPIC_API_KEY (regular key, not admin key).
  Skill IDs are slugs, not UUIDs.

Example:
  $ vat claude org skills list
`);

  // install (stub)
  const installCmd = new Command('install');
  installCmd
    .description('Install a skill (not yet implemented)')
    .argument('<source>', 'Skill source')
    .action(() => {
      writeNotYetImplementedStub('org skills install');
      process.exit(1);
    });

  // delete (stub)
  const deleteCmd = new Command('delete');
  deleteCmd
    .description('Delete a skill (not yet implemented)')
    .argument(SKILL_ID_ARG, SKILL_ID_DESC)
    .action(() => {
      writeNotYetImplementedStub('org skills delete');
      process.exit(1);
    });

  // versions subgroup
  const versionsCmd = new Command('versions');
  versionsCmd.description('Manage skill versions').helpCommand(false);

  const versionsListCmd = new Command('list');
  versionsListCmd
    .description('List versions of a skill (not yet implemented)')
    .argument(SKILL_ID_ARG, SKILL_ID_DESC)
    .action(() => {
      writeNotYetImplementedStub('org skills versions list');
      process.exit(1);
    });

  const versionsDeleteCmd = new Command('delete');
  versionsDeleteCmd
    .description('Delete a skill version (not yet implemented)')
    .argument(SKILL_ID_ARG, SKILL_ID_DESC)
    .argument('<version>', 'Version to delete')
    .action(() => {
      writeNotYetImplementedStub('org skills versions delete');
      process.exit(1);
    });

  versionsCmd.addCommand(versionsListCmd);
  versionsCmd.addCommand(versionsDeleteCmd);

  command.addCommand(listCmd);
  command.addCommand(installCmd);
  command.addCommand(deleteCmd);
  command.addCommand(versionsCmd);

  return command;
}
