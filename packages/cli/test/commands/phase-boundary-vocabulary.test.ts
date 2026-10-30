/**
 * The three orchestrator commands describe the process they actually run in.
 *
 * `runPhase` runs every phase in THIS process: a phase hands back its
 * `{ report }`, which is everything an orchestrator ever read back across the
 * old boundary. With the boundary gone, three failure arms went
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
 *
 * One phase is the exception, and it is named rather than tolerated: `vat
 * validate`'s `checks` phase runs `vat resources check`'s supervised child, so
 * that command's help may speak of the child's population and must say the
 * child belongs to the checks phase. Every other term stays banned there, and
 * `vat verify` and `vat build` keep the whole list.
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

/** The terms the `checks` phase's supervised child makes true — allowed only where that phase runs. */
const CHECKS_CHILD_TERMS: readonly string[] = ["child's"];
const NO_CHILD_TERMS: readonly string[] = [];

const ORCHESTRATORS = [
  ['vat validate', createValidateTopLevelCommand, 'resources', CHECKS_CHILD_TERMS],
  ['vat verify', createVerifyTopLevelCommand, 'consistency', NO_CHILD_TERMS],
  ['vat build', createBuildTopLevelCommand, 'skills', NO_CHILD_TERMS],
] as const;

describe('orchestrator help text describes in-process phases', () => {
  it.each(ORCHESTRATORS)('%s names its phases', (_name, create, ownPhase) => {
    expect(renderCommandHelp(create())).toContain(ownPhase);
  });

  it.each(ORCHESTRATORS)('%s claims no process boundary its phases lack', (_name, create, _phase, allowed) => {
    const help = renderCommandHelp(create()).toLowerCase();

    for (const [term, why] of NO_SUCH_BOUNDARY) {
      if (allowed.includes(term)) continue;
      expect(help, `help still says "${term}" — ${why}`).not.toContain(term);
    }
  });

  it('vat validate ties its one child to the checks phase', () => {
    const help = renderCommandHelp(createValidateTopLevelCommand()).toLowerCase();

    expect(help).toContain('checks child');
    expect(help).toContain("'vat resources check''s supervised child");
  });
});
