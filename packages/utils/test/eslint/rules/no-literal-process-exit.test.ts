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
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
