/**
 * Unit tests for permission-matcher.ts
 * Verifies our reimplementation of Claude Code's permission matching logic.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyBashRule,
  isSubsumedBy,
  matchesBashRule,
  matchesPermissionRule,
  parseBashRuleContent,
  parsePermissionRule,
} from '../src/settings/permission-matcher.js';

// String constants to avoid sonarjs/no-duplicate-string
const EXACT = 'exact';
const WILDCARD = 'wildcard';
const PREFIX = 'prefix';
const NPM_RUN_LINT = 'npm run lint';
const NPM_RUN_STAR = 'npm run *';
const NPM_RUN_PREFIX = 'npm run:*';
const GIT_STATUS = 'git status';
const GIT_STAR_CONTENT = 'git *';
const GIT_STAR = 'Bash(git *)';
const GIT_PUSH_STAR = 'Bash(git push *)';
const BASH_NPM_RUN_LINT = 'Bash(npm run lint)';
const BASH_NPM_RUN_STAR = 'Bash(npm run *)';
const BASH_NPM_RUN_PREFIX = 'Bash(npm run:*)';
const GIT_PUSH_ORIGIN_MAIN = 'git push origin main';
const LS_STAR = 'Bash(ls *)';
const LS_GLUED = 'Bash(ls*)';
const LS_LA = 'ls -la';
const LSOF = 'lsof';

describe('parsePermissionRule', () => {
  it('parses bare tool name', () => {
    const result = parsePermissionRule('Edit');
    expect(result).toEqual({ toolName: 'Edit', content: undefined });
  });

  it('parses tool with content', () => {
    const result = parsePermissionRule(BASH_NPM_RUN_STAR);
    expect(result).toEqual({ toolName: 'Bash', content: NPM_RUN_STAR });
  });

  it('parses tool with path content', () => {
    const result = parsePermissionRule('Read(./.env)');
    expect(result).toEqual({ toolName: 'Read', content: './.env' });
  });

  it('normalises whitespace in rule', () => {
    const result = parsePermissionRule('Bash(  npm  run  *  )');
    expect(result).toEqual({ toolName: 'Bash', content: NPM_RUN_STAR });
  });
});

describe('classifyBashRule', () => {
  it('classifies exact rules', () => {
    expect(classifyBashRule(NPM_RUN_LINT)).toBe(EXACT);
    expect(classifyBashRule(GIT_STATUS)).toBe(EXACT);
  });

  it('classifies wildcard rules', () => {
    expect(classifyBashRule(NPM_RUN_STAR)).toBe(WILDCARD);
    expect(classifyBashRule(GIT_STAR_CONTENT)).toBe(WILDCARD);
    expect(classifyBashRule('*')).toBe(WILDCARD);
  });

  it('classifies legacy prefix rules', () => {
    expect(classifyBashRule(NPM_RUN_PREFIX)).toBe(PREFIX);
    expect(classifyBashRule('git:*')).toBe(PREFIX);
  });

  it('does not classify escaped * as wildcard', () => {
    expect(classifyBashRule(String.raw`git commit -m "fix \*"`)).toBe(EXACT);
  });
});

describe('matchesBashRule', () => {
  it('bare Bash matches any command', () => {
    expect(matchesBashRule(NPM_RUN_LINT, 'Bash')).toBe(true);
    expect(matchesBashRule(GIT_PUSH_ORIGIN_MAIN, 'Bash')).toBe(true);
  });

  it('Bash(*) matches any command', () => {
    expect(matchesBashRule(NPM_RUN_LINT, 'Bash(*)')).toBe(true);
    expect(matchesBashRule(GIT_PUSH_ORIGIN_MAIN, 'Bash(*)')).toBe(true);
  });

  it('exact rule matches same command', () => {
    expect(matchesBashRule(NPM_RUN_LINT, BASH_NPM_RUN_LINT)).toBe(true);
    expect(matchesBashRule('npm run test', BASH_NPM_RUN_LINT)).toBe(false);
  });

  it('wildcard * matches spaces (git * matches git push origin main)', () => {
    expect(matchesBashRule(GIT_PUSH_ORIGIN_MAIN, GIT_STAR)).toBe(true);
    expect(matchesBashRule(GIT_STATUS, GIT_STAR)).toBe(true);
    // ⚠️ This used to assert `false` with the comment "no space after git", and
    // that PINNED divergence #1 rather than catching it. The published table:
    // *"A `*` at the end, with a space before it, also matches the bare
    // command."* The space rule it was reaching for is a different one — it
    // makes `ls` a whole word, so `Bash(ls *)` still refuses `lsof` (asserted
    // in the next test) — and conflating the two is what kept the bug green.
    expect(matchesBashRule('git', GIT_STAR)).toBe(true);
  });

  it('wildcard anchoring: Bash(ls *) does NOT match lsof', () => {
    expect(matchesBashRule(LS_LA, LS_STAR)).toBe(true);
    expect(matchesBashRule(LSOF, LS_STAR)).toBe(false);
  });

  it('non-Bash rule does not match', () => {
    expect(matchesBashRule(NPM_RUN_LINT, 'Edit')).toBe(false);
    expect(matchesBashRule(NPM_RUN_LINT, 'Read(./.env)')).toBe(false);
  });

  it('normalises whitespace before matching', () => {
    expect(matchesBashRule('npm  run  lint', BASH_NPM_RUN_LINT)).toBe(true);
  });

  it('prefix rule matches base and base + args', () => {
    expect(matchesBashRule('npm run', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule(NPM_RUN_LINT, BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule('xargs npm run', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule('xargs npm run lint', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(matchesBashRule('npm install', BASH_NPM_RUN_PREFIX)).toBe(false);
  });
});

describe('matchesPermissionRule', () => {
  it('bare Edit matches any Edit call', () => {
    expect(matchesPermissionRule('Edit', '/some/file.ts', 'Edit')).toBe(true);
    expect(matchesPermissionRule('Edit', '/any/path', 'Edit')).toBe(true);
  });

  it('wrong tool name does not match', () => {
    expect(matchesPermissionRule('Bash', NPM_RUN_LINT, 'Edit')).toBe(false);
    expect(matchesPermissionRule('Edit', '/file', 'Bash')).toBe(false);
  });

  it('tool names are case-sensitive', () => {
    expect(matchesPermissionRule('bash', NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(false);
    expect(matchesPermissionRule('Bash', NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(true);
  });
});

describe('isSubsumedBy', () => {
  it('identical rules subsume each other', () => {
    expect(isSubsumedBy(GIT_PUSH_STAR, GIT_PUSH_STAR)).toBe(true);
  });

  it('broad wildcard subsumes narrow wildcard', () => {
    expect(isSubsumedBy(GIT_PUSH_STAR, GIT_STAR)).toBe(true);
    expect(isSubsumedBy(GIT_STAR, 'Bash(*)')).toBe(true);
  });

  it('does not subsume in wrong direction', () => {
    expect(isSubsumedBy(GIT_STAR, GIT_PUSH_STAR)).toBe(false);
  });

  it('bare tool name subsumes everything for that tool', () => {
    expect(isSubsumedBy(GIT_STAR, 'Bash')).toBe(true);
    expect(isSubsumedBy('Edit', 'Edit')).toBe(true);
  });

  it('different tools never subsume', () => {
    expect(isSubsumedBy('Bash(*)', 'Edit')).toBe(false);
  });

  it('exact broad subsumes exact narrow with same content', () => {
    expect(isSubsumedBy(BASH_NPM_RUN_LINT, BASH_NPM_RUN_LINT)).toBe(true);
    expect(isSubsumedBy(BASH_NPM_RUN_LINT, 'Bash(npm run test)')).toBe(false);
  });

  // 🚩 A `:*` broad rule used to subsume NOTHING — the prefix case fell through
  // to `return false`. The conflict analyzer is built on this function, so a
  // redundant rule under a `:*` parent was never reported.
  it('a ":*" prefix rule subsumes the commands it permits', () => {
    expect(isSubsumedBy(BASH_NPM_RUN_LINT, BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(isSubsumedBy('Bash(npm install)', BASH_NPM_RUN_PREFIX)).toBe(false);
  });

  // 🚩 `isSubsumedBy` and `matchesBashRule` have to agree about the same pair,
  // and they did not: once `Bash(ls *)` began permitting bare `ls`, the rule
  // `Bash(ls)` became redundant, but subsumption still said otherwise.
  it('agrees with matchesBashRule about the bare-command rule', () => {
    expect(matchesBashRule('ls', LS_STAR)).toBe(true);
    expect(isSubsumedBy('Bash(ls)', LS_STAR)).toBe(true);
  });
});

describe('parseBashRuleContent', () => {
  it('builds regex for wildcard rules', () => {
    const parsed = parseBashRuleContent(NPM_RUN_STAR);
    expect(parsed.type).toBe(WILDCARD);
    expect(parsed.regex).toBeDefined();
    expect(parsed.regex?.test(NPM_RUN_LINT)).toBe(true);
    expect(parsed.regex?.test('npm run build')).toBe(true);
    expect(parsed.regex?.test('npm install')).toBe(false);
  });

  it('strips :* from prefix rules', () => {
    const parsed = parseBashRuleContent(NPM_RUN_PREFIX);
    expect(parsed.type).toBe(PREFIX);
    expect(parsed.content).toBe('npm run');
  });

  it('returns exact type for literal commands', () => {
    const parsed = parseBashRuleContent(GIT_STATUS);
    expect(parsed.type).toBe(EXACT);
    expect(parsed.content).toBe(GIT_STATUS);
  });
});

// ============================================================================
// Conformance to the PUBLISHED behavior table
// ============================================================================
//
// Every expectation below is sourced from <https://code.claude.com/docs/en/permissions>,
// read 2026-09-06, and each case quotes the sentence it encodes. These are the
// divergences the module header enumerated as findings; the table is the only
// authority that falsifies cheaply, so it is the one the suite pins.
//
// ⚠️ These assert the DOCUMENTED behavior, not a decompile. They can prove the
// replica wrong; they cannot prove it right.

const SAFE_CMD_STAR = 'Bash(safe-cmd *)';
const NPM_STAR = 'Bash(npm *)';
const GREP_STAR = 'Bash(grep *)';
const NPM_TEST_STAR = 'Bash(npm test *)';
const NPM_TEST = 'npm test';
const ECHO_STAR = 'Bash(echo *)';

describe('published table — trailing wildcard', () => {
  // "A `*` at the end, with a space before it, also matches the bare command.
  //  `Bash(ls *)` matches `ls`, and `Bash(git log *)` matches `git log`."
  it('a trailing " *" matches the bare command', () => {
    expect(matchesBashRule('ls', LS_STAR)).toBe(true);
    expect(matchesBashRule('git log', 'Bash(git log *)')).toBe(true);
  });

  // "That holds only when the trailing `*` is the rule's only wildcard:
  //  `Bash(* --help *)` matches `npm --help x` but not `npm --help`."
  it('does not match the bare command when another wildcard is present', () => {
    expect(matchesBashRule('npm --help x', 'Bash(* --help *)')).toBe(true);
    expect(matchesBashRule('npm --help', 'Bash(* --help *)')).toBe(false);
  });

  // "The space before a trailing `*` is part of the rule. `Bash(ls *)` requires
  //  a space after `ls`, so `lsof` doesn't match. `Bash(ls*)` has no space, so
  //  it matches `lsof` too."
  it('honours the space before a trailing wildcard', () => {
    expect(matchesBashRule(LS_LA, LS_STAR)).toBe(true);
    expect(matchesBashRule(LSOF, LS_STAR)).toBe(false);
    expect(matchesBashRule(LSOF, LS_GLUED)).toBe(true);
    expect(matchesBashRule(LS_LA, LS_GLUED)).toBe(true);
  });

  // "The `:*` suffix is an equivalent way to write a trailing wildcard, so
  //  `Bash(ls:*)` matches the same commands as `Bash(ls *)`."
  it('treats ":*" as equivalent to a trailing " *"', () => {
    for (const command of ['ls', LS_LA]) {
      expect(matchesBashRule(command, 'Bash(ls:*)')).toBe(matchesBashRule(command, LS_STAR));
    }
    expect(matchesBashRule(LSOF, 'Bash(ls:*)')).toBe(false);
  });
});

describe('published table — compound commands', () => {
  // "a rule like `Bash(safe-cmd *)` won't give it permission to run the command
  //  `safe-cmd && other-cmd`. The recognized command separators are `&&`, `||`,
  //  `;`, `|`, `|&`, `&`, and newlines. A rule must match each subcommand
  //  independently."
  it('refuses a compound command when a subcommand does not match', () => {
    expect(matchesBashRule('safe-cmd && other-cmd', SAFE_CMD_STAR)).toBe(false);
  });

  it('recognises every documented separator', () => {
    for (const sep of ['&&', '||', ';', '|', '|&', '&', '\n']) {
      expect(matchesBashRule(`safe-cmd ${sep} other-cmd`, SAFE_CMD_STAR)).toBe(false);
    }
  });

  it('allows a compound command when every subcommand matches', () => {
    expect(matchesBashRule('npm test && npm run lint', NPM_STAR)).toBe(true);
  });

  // "When `&&` or `||` has nothing after it, such as in `npm test &&`, Claude
  //  Code treats the command as unparseable and doesn't split it into
  //  subcommands for allow-rule matching, so a rule such as `Bash(npm *)`
  //  doesn't approve it."
  it('treats a dangling operator as unparseable', () => {
    expect(matchesBashRule('npm test &&', NPM_STAR)).toBe(false);
    expect(matchesBashRule('npm test ||', NPM_STAR)).toBe(false);
  });

  // A trailing `;` is ordinary shell, not the unparseable form the table names.
  it('does not treat a trailing ";" as unparseable', () => {
    expect(matchesBashRule('npm test;', NPM_STAR)).toBe(true);
  });

  // 🚩 Regression guard for a defect introduced WITH the compound splitting and
  // caught in review: the first implementation split with a regex, which is
  // blind to quoting, so `grep -E "a|b" file` split at the `|` inside the
  // quotes and left `b" file` as a subcommand no rule matches. Quoted
  // separators are far too common to break.
  it('does not split on a separator inside quotes', () => {
    expect(matchesBashRule('grep -E "a|b" file', GREP_STAR)).toBe(true);
    expect(matchesBashRule("grep -E 'a&&b' file", GREP_STAR)).toBe(true);
    expect(matchesBashRule('git commit -m "fix: a && b"', 'Bash(git commit *)')).toBe(true);
    expect(matchesBashRule('echo "a; b"', ECHO_STAR)).toBe(true);
  });

  // Same class: a separator inside `$(…)` or `(…)` is not top level.
  it('does not split inside a subshell or command substitution', () => {
    expect(matchesBashRule('echo $(ls | wc -l)', ECHO_STAR)).toBe(true);
  });

  // An escaped separator is a literal character, not a split point.
  it('does not split on an escaped separator', () => {
    expect(matchesBashRule(String.raw`echo a\&\&b`, ECHO_STAR)).toBe(true);
  });
});

describe('published table — wrappers', () => {
  // "Before matching Bash rules, Claude Code strips a fixed set of wrappers, so
  //  a rule like `Bash(npm test *)` also matches `timeout 30 npm test`. The
  //  stripped wrappers are `timeout`, `time`, `nice`, `nohup`, and `stdbuf`,
  //  plus the shell builtins `command` and `builtin`, and zsh's `noglob`."
  it('strips the documented wrappers', () => {
    expect(matchesBashRule('timeout 30 npm test', NPM_TEST_STAR)).toBe(true);
    for (const wrapper of ['time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']) {
      expect(matchesBashRule(`${wrapper} ${NPM_TEST}`, NPM_TEST_STAR)).toBe(true);
    }
  });

  // "Two related forms aren't stripped: the query form `command -v`, which looks
  //  up a command rather than running one, and zsh's `nocorrect`."
  it('does not strip "command -v" or "nocorrect"', () => {
    expect(matchesBashRule('command -v npm test', NPM_TEST_STAR)).toBe(false);
    expect(matchesBashRule('nocorrect npm test', NPM_TEST_STAR)).toBe(false);
  });

  // "Bare `xargs` is also stripped, so `Bash(grep *)` matches `xargs grep
  //  pattern`. Stripping applies only when `xargs` has no flags: an invocation
  //  like `xargs -n1 grep pattern` is matched as an `xargs` command."
  it('strips bare xargs but not xargs with flags', () => {
    expect(matchesBashRule('xargs grep pattern', GREP_STAR)).toBe(true);
    expect(matchesBashRule('xargs -n1 grep pattern', GREP_STAR)).toBe(false);
  });
});
