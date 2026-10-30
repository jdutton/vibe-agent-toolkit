/**
 * 🔑 What interrupting a supervised checks run does is ONE text, and both commands that supervise a
 * checks child render it whole — so `vat validate --help` and `vat resources check --help` cannot
 * describe it differently. They used to carry two hand-written paragraphs that had drifted apart.
 */

import { describe, expect, it } from 'vitest';

import { SUPERVISION_SIGNAL_CONTRACT } from '../../src/commands/resources/check-supervisor.js';
import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { createValidateTopLevelCommand } from '../../src/commands/validate.js';
import { renderCommandHelp } from '../help-text-helpers.js';

/** `vat resources check`'s own command, out of its group. */
function resourcesCheckCommand(): Parameters<typeof renderCommandHelp>[0] {
  const check = createResourcesCommand().commands.find((command) => command.name() === 'check');
  if (check === undefined) throw new Error('no `check` subcommand under `vat resources`');
  return check;
}

describe('the supervision signal contract', () => {
  it.each([
    ['vat validate', () => renderCommandHelp(createValidateTopLevelCommand())],
    ['vat resources check', () => renderCommandHelp(resourcesCheckCommand())],
  ])('%s --help renders it whole, once', (_command, help) => {
    const text = help();
    expect(text.split(SUPERVISION_SIGNAL_CONTRACT)).toHaveLength(2);
  });

  it('states both platforms and both orphan endings', () => {
    for (const claim of ['POSIX:', 'Windows:', 'end-of-file', 'last check returns', 'kills the wrapper alone']) {
      expect(SUPERVISION_SIGNAL_CONTRACT).toContain(claim);
    }
  });

  // The child is not a process-group leader (that would put it outside the terminal's job
  // control), so on POSIX a process it started is not killed with it.
  it('claims no kill of what the child itself started on POSIX', () => {
    expect(SUPERVISION_SIGNAL_CONTRACT).toContain('(git) is not\n  killed with it');
    expect(SUPERVISION_SIGNAL_CONTRACT).not.toMatch(/every process it started|process group as it exits/);
  });
});
