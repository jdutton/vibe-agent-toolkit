/**
 * `no-text-git-object-read` — an argv reading git's object store (`ls-tree`,
 * `cat-file`, `diff-tree`, `rev-list`, `show`) is handed only to `runGitBytes`.
 * The VALID cases pin the bytes runner, the subcommand position (a global option
 * and its value are skipped, a later element is not the subcommand), and that
 * other subcommands are out of scope; the INVALID ones pin the text runners, a
 * wrapper however it is named, and an argv parked in a variable first.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-text-git-object-read';
const SRC = '/repo/packages/agent-skills/src/skill-source/clone.ts';

const CASES: RuleCases = {
  valid: [
    { code: "runGitBytes(['ls-tree', '-r', '-z', commit], { cwd });", filename: SRC },
    { code: "runGitBytes(['cat-file', '--batch'], { cwd, input });", filename: SRC },
    { code: "git.runGitBytes(['show', `${commit}:a.md`]);", filename: SRC },
    { code: "runGitBytes(['-c', 'core.quotepath=false', 'diff-tree', '-r', '-z', commit]);", filename: SRC },
    // Other subcommands are not object-store reads — `show` as a SUB-subcommand included.
    { code: "runGit(['rev-parse', 'HEAD'], { cwd });", filename: SRC },
    { code: "runGit(['ls-files', '-z'], { cwd, trim: false });", filename: SRC },
    { code: "runGit(['remote', 'show', 'origin']);", filename: SRC },
    // A global option's VALUE is not the subcommand.
    { code: "runGit(['-C', 'show', 'status']);", filename: SRC },
    { code: "runGit(['--git-dir', 'ls-tree', 'status']);", filename: SRC },
    // A list of words that never reaches a call is not an argv.
    { code: "const MODES = ['show', 'hide']; const ok = MODES.includes(mode);", filename: SRC },
    { code: "const options = { modes: ['show', 'hide'] };", filename: SRC },
  ],
  invalid: [
    { code: "runGit(['ls-tree', '-r', '-z', commit], { cwd, trim: false });", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'ls-tree' } }] },
    { code: "runGitOrThrow(['cat-file', 'blob', oid]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'cat-file' } }] },
    { code: "executeGitCommand(['cat-file', '--batch'], { stdin });", filename: SRC, errors: [{ messageId: 'textRead' }] },
    { code: "runGit(['diff-tree', '-r', '--name-only', commit]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'diff-tree' } }] },
    { code: "runGit(['rev-list', '--objects', 'HEAD']);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'rev-list' } }] },
    { code: "runGit(['show', `${commit}:a.md`], { trim: false });", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'show' } }] },
    // The subcommand after global options is still the subcommand.
    { code: "runGit(['-c', 'core.quotepath=false', 'ls-tree', commit]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'ls-tree' } }] },
    // Parked in a variable, then handed to anything: the literal is the read.
    { code: "const args = ['ls-tree', commit]; runGitBytes(args);", filename: SRC, errors: [{ messageId: 'textRead' }] },
    // A global option's value that is not a literal is still skipped.
    { code: "runGit(['-C', dir, 'cat-file', '--batch']);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'cat-file' } }] },
    { code: "runGit(['-c', `core.x=${v}`, 'ls-tree', c]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'ls-tree' } }] },
    { code: "runGit(['--git-dir', gitDir, 'cat-file', 'blob', o]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'cat-file' } }] },
    // Global options spread in front of the subcommand.
    { code: "runGit([...configArgs, 'ls-tree', c]);", filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'ls-tree' } }] },
    // A template literal with no expressions is a literal.
    { code: 'runGit([`show`, c]);', filename: SRC, errors: [{ messageId: 'textRead', data: { subcommand: 'show' } }] },
    // Spread into the argv a call is handed.
    { code: "runGit([...['cat-file', '--batch']]);", filename: SRC, errors: [{ messageId: 'textRead' }] },
    // Not the argv position of the bytes runner.
    { code: "runGitBytes(['--version'], ['cat-file']);", filename: SRC, errors: [{ messageId: 'textRead' }] },
    // A wrapper is not the bytes runner, whatever its name says: it may decode.
    { code: "readCloneBytes(['cat-file', '--batch'], cloneDir);", filename: SRC, errors: [{ messageId: 'textRead' }] },
    { code: "readBytesOf(['ls-tree', commit]);", filename: SRC, errors: [{ messageId: 'textRead' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
