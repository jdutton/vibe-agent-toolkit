import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * The `…Phase` suffix is the whole marker, so the cases that matter most are the
 * VALID ones: a rule that fired on the command wrappers too would be unusable,
 * and a rule blind to an arrow const would be inert against half the ways a
 * phase can be written.
 */
const CASES: RuleCases = {
  valid: [
    // The command wrapper: deciding how the process ends is exactly its job.
    { code: 'async function validateCommand() { const r = await run(); process.exit(r.exitCode); }' },
    // A phase that returns rather than exits.
    { code: 'async function runSkillsBuildPhase() { return { document: undefined, exitCode: 2 }; }' },
    // `Phase` in the middle of a name is not the suffix.
    { code: 'function phaseNames() { process.exit(1); }' },
    { code: 'function runPhaseSelection() { process.exit(1); }' },
    // A bare `exit()` that is not `process.exit`.
    { code: 'function runXPhase() { exit(1); }' },
    { code: 'function runXPhase() { server.exit(1); }' },
  ],
  invalid: [
    {
      code: 'async function runResourcesValidatePhase() { process.exit(1); }',
      errors: [{ messageId: 'exitInPhase' }],
    },
    // Nested inside a branch, which is how every real one of these was written.
    {
      code: 'async function runSkillsBuildPhase() { if (bad) { process.exit(2); } return ok; }',
      errors: [{ messageId: 'exitInPhase' }],
    },
    // An arrow const — the shape a name-keyed rule most easily goes blind to.
    {
      code: 'const runMarketplaceValidatePhase = () => { process.exit(0); };',
      errors: [{ messageId: 'exitInPhase' }],
    },
    // A function expression assigned to a phase-named const.
    {
      code: 'const runSkillsValidatePhase = function () { process.exit(0); };',
      errors: [{ messageId: 'exitInPhase' }],
    },
    // Buried in an inner callback: still lexically inside the phase, still ends
    // the whole run when it fires.
    {
      code: 'async function runXPhase() { items.forEach(() => { process.exit(1); }); }',
      errors: [{ messageId: 'exitInPhase' }],
    },
  ],
};

describe('no-process-exit-in-phase', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-process-exit-in-phase', CASES); });
});
