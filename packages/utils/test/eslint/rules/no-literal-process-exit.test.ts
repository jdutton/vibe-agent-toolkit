/**
 * `no-literal-process-exit` — an exit code written as a number re-decides the
 * exit contract at the call site. The cases that matter most are the VALID ones
 * naming an `ExitCode` member, because a rule that fired on those would push
 * every command back to the literal it was meant to remove.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-literal-process-exit';
const LINTED = '/repo/packages/cli/src/commands/build.ts';
const BIN_FALLBACK = 'packages/cli/src/bin.ts';
const ALLOW_BIN = [{ allow: [BIN_FALLBACK] }];

/** A file under the derived scope, and one that is its legacy exception. */
const DERIVED_FILE = '/repo/packages/cli/src/commands/okf/validate.ts';
const LEGACY_FILE = '/repo/packages/cli/src/commands/audit.ts';
const OUTSIDE_FILE = '/repo/packages/dev-tools/src/check.ts';
const DERIVED = [{
  derived: {
    paths: ['packages/cli/src/'],
    calls: ['exitCodeForReport', 'exitCodeOfChild'],
    legacy: ['packages/cli/src/commands/audit.ts'],
  },
}];

const CASES: RuleCases = {
  valid: [
    // The shape the rule exists to make universal.
    { code: 'process.exit(ExitCode.FINDINGS);', filename: LINTED },
    { code: 'process.exitCode = ExitCode.OK;', filename: LINTED },
    // Any non-literal: an identifier, a member, a call result.
    { code: 'process.exit(code);', filename: LINTED },
    { code: 'process.exit(result.exitCode);', filename: LINTED },
    { code: 'process.exit(exitCodeForPhases(results));', filename: LINTED },
    { code: 'process.exitCode = ending.exitCode;', filename: LINTED },
    // A ternary whose branches are BOTH enum members carries no literal.
    { code: 'process.exit(ok ? ExitCode.OK : ExitCode.FINDINGS);', filename: LINTED },
    // No argument at all: the process ends with whatever `exitCode` holds.
    { code: 'process.exit();', filename: LINTED },
    // Not `process` — a method that happens to be called `exit`.
    { code: 'server.exit(1);', filename: LINTED },
    { code: 'exit(1);', filename: LINTED },
    { code: 'const o = { exitCode: 1 };', filename: LINTED },
    // The declared last-resort fallback file, named by repo-relative path.
    { code: 'process.exit(1);', filename: `/repo/${BIN_FALLBACK}`, options: ALLOW_BIN },
    { code: 'process.exitCode = 2;', filename: String.raw`C:\repo\packages\cli\src\bin.ts`, options: ALLOW_BIN },

    // `derived`: the two members that are not claims about a document, and the derivations.
    { code: 'process.exit(ExitCode.OK);', filename: DERIVED_FILE, options: DERIVED },
    { code: 'process.exit(ExitCode.ERROR);', filename: DERIVED_FILE, options: DERIVED },
    { code: 'process.exit(exitCodeForReport(report));', filename: DERIVED_FILE, options: DERIVED },
    { code: 'process.exit(schema.exitCodeForReport(report, { strict }));', filename: DERIVED_FILE, options: DERIVED },
    { code: 'process.exitCode = exitCodeOfChild(result.status);', filename: DERIVED_FILE, options: DERIVED },
    // Outside the derived scope the old floor still applies, and only it.
    { code: 'process.exit(ok ? ExitCode.OK : ExitCode.FINDINGS);', filename: OUTSIDE_FILE, options: DERIVED },
    // A test file is not a verb.
    { code: 'process.exit(ExitCode.FINDINGS);', filename: '/repo/packages/cli/src/commands/x.test.ts', options: DERIVED },
    // A LEGACY file may still decide by hand — that is what the entry says.
    { code: 'process.exit(bad ? ExitCode.FINDINGS : ExitCode.OK);', filename: LEGACY_FILE, options: DERIVED },
  ],
  invalid: [
    { code: 'process.exit(0);', filename: LINTED, errors: [{ messageId: 'literalExit', data: { literal: '0' } }] },
    { code: 'process.exit(1);', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    { code: 'process.exit(2);', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    // A negative literal is still a literal.
    { code: 'process.exit(-1);', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    // The literal hides inside a conditional or a nullish fallback.
    { code: 'process.exit(errors > 0 ? 1 : 0);', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    { code: 'process.exit(result.status ?? 1);', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    { code: 'process.exit(ok ? ExitCode.OK : 1);', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    { code: 'process.exitCode = 1;', filename: LINTED, errors: [{ messageId: 'literalExitCode' }] },
    { code: 'process.exitCode = failed ? 2 : 0;', filename: LINTED, errors: [{ messageId: 'literalExitCode' }] },
    // Nested in a function: still the same call.
    { code: 'function main() { if (bad) { process.exit(1); } }', filename: LINTED, errors: [{ messageId: 'literalExit' }] },
    // The allow list names ONE file; a sibling with the same basename elsewhere is not it.
    { code: 'process.exit(1);', filename: '/repo/packages/lab/src/bin.ts', options: ALLOW_BIN, errors: [{ messageId: 'literalExit' }] },
    // No options at all: nothing is allowed.
    { code: 'process.exit(1);', filename: `/repo/${BIN_FALLBACK}`, errors: [{ messageId: 'literalExit' }] },

    // `derived`: FINDINGS may not be NAMED, even outside an exit call.
    { code: 'process.exit(ExitCode.FINDINGS);', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'findingsNotDerived' }] },
    { code: 'const code = failed ? ExitCode.FINDINGS : ExitCode.OK;', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'findingsNotDerived' }] },
    // A ternary of the two permitted members is still a decision beside the document.
    { code: 'process.exit(partial ? ExitCode.ERROR : ExitCode.OK);', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'exitNotDerived' }] },
    // A forwarded field is a code decided somewhere this rule cannot see.
    { code: 'process.exit(outcome.exitCode);', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'exitNotDerived' }] },
    { code: 'process.exitCode = code;', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'exitNotDerived' }] },
    // A call that is not a derivation is not one because it returns a number.
    { code: 'process.exit(exitCodeForPhases(results));', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'exitNotDerived' }] },
    // A literal is still reported ONCE, as a literal.
    { code: 'process.exit(1);', filename: DERIVED_FILE, options: DERIVED, errors: [{ messageId: 'literalExit' }] },
    // The ratchet's other direction: a legacy file that decides nothing by hand is a stale entry.
    { code: 'process.exit(exitCodeForReport(report));', filename: LEGACY_FILE, options: DERIVED, errors: [{ messageId: 'staleLegacy' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
