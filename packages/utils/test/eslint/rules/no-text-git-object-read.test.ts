/**
 * `no-text-git-object-read` — an argv reading git's object store (`ls-tree`,
 * `cat-file`) is handed only to a bytes runner. The VALID cases pin the bytes
 * runner and its wrappers, and that other subcommands are out of scope; the
 * INVALID ones pin the text runners and an argv parked in a variable first.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-text-git-object-read';
const SRC = '/repo/packages/agent-skills/src/skill-source/clone.ts';

const CASES: RuleCases = {
  valid: [
    { code: "runGitBytes(['ls-tree', '-r', '-z', commit], { cwd });", filename: SRC },
    { code: "runGitBytes(['cat-file', '--batch'], { cwd, input });", filename: SRC },
    // A wrapper of the bytes runner, named as one.
    { code: "readCloneBytes(['cat-file', '--batch'], cloneDir, 'read', input);", filename: SRC },
    { code: "git.runGitBytes(['ls-tree', commit]);", filename: SRC },
    // Other subcommands are not object-store reads.
    { code: "runGit(['rev-parse', 'HEAD'], { cwd });", filename: SRC },
    { code: "runGit(['ls-files', '-z'], { cwd, trim: false });", filename: SRC },
  ],
  invalid: [
    { code: "runGit(['ls-tree', '-r', '-z', commit], { cwd, trim: false });", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'ls-tree' } }] },
    { code: "runGitOrThrow(['cat-file', 'blob', oid]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'cat-file' } }] },
    { code: "executeGitCommand(['cat-file', '--batch'], { stdin });", filename: SRC, errors: [{ messageId: 'textRead' }] },
    // Parked in a variable, then handed to anything: the literal is the read.
    { code: "const args = ['ls-tree', commit]; runGitBytes(args);", filename: SRC, errors: [{ messageId: 'textRead' }] },
    // Not the argv position of a bytes runner.
    { code: "runGitBytes(['--version'], { extra: ['cat-file'] });", filename: SRC, errors: [{ messageId: 'textRead' }] },
    // A name merely containing Bytes is not a bytes runner.
    { code: "readBytesOf(['ls-tree', commit]);", filename: SRC, errors: [{ messageId: 'textRead' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
