/**
 * 🔑 What interrupting a supervised run does is ONE text, and every command that supervises a child
 * renders it whole — so `vat validate --help`, `vat resources check --help` and
 * `vat resources query --help` cannot describe it differently. Two of them used to carry
 * hand-written paragraphs that had drifted apart.
 */

import { describe, expect, it } from 'vitest';

import { SUPERVISION_SIGNAL_CONTRACT } from '../../src/commands/resources/check-supervisor.js';
import { createResourcesCommand } from '../../src/commands/resources/index.js';
import { createValidateTopLevelCommand } from '../../src/commands/validate.js';
import { renderCommandHelp } from '../help-text-helpers.js';

/** A `vat resources` subcommand, out of its group. */
function resourcesCommand(name: string): Parameters<typeof renderCommandHelp>[0] {
  const found = createResourcesCommand().commands.find((command) => command.name() === name);
  if (found === undefined) throw new Error(`no \`${name}\` subcommand under \`vat resources\``);
  return found;
}

describe('the supervision signal contract', () => {
  it.each([
    ['vat validate', () => renderCommandHelp(createValidateTopLevelCommand())],
    ['vat resources check', () => renderCommandHelp(resourcesCommand('check'))],
    ['vat resources query', () => renderCommandHelp(resourcesCommand('query'))],
  ])('%s --help renders it whole, once', (_command, help) => {
    const text = help();
    expect(text.split(SUPERVISION_SIGNAL_CONTRACT)).toHaveLength(2);
  });

  it('states both platforms and both orphan endings', () => {
    for (const claim of ['POSIX:', 'Windows:', 'end-of-file', 'last check returns', 'once its statement returns', 'kills the wrapper alone']) {
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
