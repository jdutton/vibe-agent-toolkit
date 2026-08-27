/**
 * The three orchestrator commands describe the process they actually run in.
 *
 * `runPhase` runs every phase in THIS process: a phase hands back a
 * `{ document, exitCode }` pair, which is everything an orchestrator ever read
 * back across the old boundary. With the boundary gone, three failure arms went
 * with it rather than being handled — a phase can no longer be killed by a
 * signal without taking the orchestrator with it, exit without a status code,
 * or write a document that fails to parse.
 *
 * That makes the vocabulary below a claim about the SHAPE OF THE OUTPUT and the
 * MEANING OF EXIT 2, not decoration: `vat validate`'s help promised a per-surface
 * `signal` and `spawn error` beside `exitCode`, and `PhaseResult` publishes
 * neither. An operator writing a CI gate against fields the document does not
 * carry is the defect this suite pins, and `--help` is the only place they would
 * read it.
 *
 * The positive half of each case is not padding: a help block that got emptied
 * would satisfy every "does not say" assertion, so each command must still be
 * shown naming its own phases.
 */

import { describe, expect, it } from 'vitest';

import { createBuildTopLevelCommand } from '../../src/commands/build.js';
import { createValidateTopLevelCommand } from '../../src/commands/validate.js';
import { createVerifyTopLevelCommand } from '../../src/commands/verify.js';
import { renderCommandHelp } from '../help-text-helpers.js';

/**
 * Words that can only be true of a phase running in another process. Matched
 * case-insensitively against rendered help, each with the reason it is false.
 */
const NO_SUCH_BOUNDARY = [
  ['subprocess', 'no phase runs in another process'],
  ['child process', 'no phase runs in another process'],
  ["child's", 'there is no child whose exit code or report to relay'],
  ['spawn', 'nothing is spawned, so nothing can fail to spawn'],
  ['killed by a signal', 'a signal that took a phase would take the orchestrator too'],
] as const;

const ORCHESTRATORS = [
  ['vat validate', createValidateTopLevelCommand, 'resources'],
  ['vat verify', createVerifyTopLevelCommand, 'consistency'],
  ['vat build', createBuildTopLevelCommand, 'skills'],
] as const;

describe('orchestrator help text describes in-process phases', () => {
  it.each(ORCHESTRATORS)('%s names its phases', (_name, create, ownPhase) => {
    expect(renderCommandHelp(create())).toContain(ownPhase);
  });

  it.each(ORCHESTRATORS)('%s claims no process boundary', (_name, create) => {
    const help = renderCommandHelp(create()).toLowerCase();

    for (const [term, why] of NO_SUCH_BOUNDARY) {
      expect(help, `help still says "${term}" — ${why}`).not.toContain(term);
    }
  });
});
