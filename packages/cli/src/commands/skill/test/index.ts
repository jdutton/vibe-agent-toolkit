/**
 * `vat skill test` command group — behavioral testing of packaged skills in isolation.
 */

import { Command } from 'commander';

import { createSkillTestConfigureCommand } from './configure.js';
import { createSkillTestRunCommand } from './run.js';

export function createSkillTestCommand(): Command {
  const command = new Command('test');
  command
    .description(
      'Behaviorally test a packaged skill in isolation (run) or configure its test block (configure)',
    )
    .helpCommand(false);
  command.addCommand(createSkillTestRunCommand());
  command.addCommand(createSkillTestConfigureCommand());
  return command;
}
