/**
 * Unit tests for permission-matcher.ts
 * Verifies our reimplementation of Claude Code's permission matching logic.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { describe, expect, it } from 'vitest';

import {
  classifyBashRule,
  isSubsumedBy,
  matchesAllowRule,
  matchesBashRule,
  matchesDenyRule,
  matchesPathRule,
  matchesPermissionRule,
  parseBashRuleContent,
  parsePermissionRule,
} from '../src/settings/permission-matcher.js';

// Every suite from here to the lane suites at the bottom of this file pins the
// ALLOW lane, and says so by binding it once rather than repeating the argument
// ~70 times. `matchesBashRule`'s `lane` is REQUIRED with no default precisely so
// that a caller cannot leave the question unanswered; binding it here answers it
// out loud. The deny/ask lane is exercised explicitly at the bottom, and the
// lane-neutral cases (path resolution, tool-name comparison) are asserted in
// every lane there.
const allowsBash = (command: string, rule: string): boolean =>
  matchesBashRule(command, rule, 'allow');

// A plugin directory that is deliberately NOT process.cwd(): every path-lane
// assertion below has to hold for a caller that passes its own root, which is
// what production does. A POSIX-absolute literal would lose its drive on
// Windows, so this is built from tmpdir().
const PLUGIN_DIR = safePath.join(normalizedTmpdir(), 'vat-permission-matcher-plugin');
const SECRETS_PATTERN = './secrets/**';
const SECRETS_KEY = './secrets/key';
const SECRETS_KEY_RELATIVE = 'secrets/key';
const HELP_STAR = 'Bash(* --help *)';
const HELP_PREFIX = 'Bash(* --help:*)';
const NPM_HELP = 'npm --help';
const NPM_HELP_X = 'npm --help x';

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
    expect(allowsBash(NPM_RUN_LINT, 'Bash')).toBe(true);
    expect(allowsBash(GIT_PUSH_ORIGIN_MAIN, 'Bash')).toBe(true);
  });

  it('Bash(*) matches any command', () => {
    expect(allowsBash(NPM_RUN_LINT, 'Bash(*)')).toBe(true);
    expect(allowsBash(GIT_PUSH_ORIGIN_MAIN, 'Bash(*)')).toBe(true);
  });

  it('exact rule matches same command', () => {
    expect(allowsBash(NPM_RUN_LINT, BASH_NPM_RUN_LINT)).toBe(true);
    expect(allowsBash('npm run test', BASH_NPM_RUN_LINT)).toBe(false);
  });

  it('wildcard * matches spaces (git * matches git push origin main)', () => {
    expect(allowsBash(GIT_PUSH_ORIGIN_MAIN, GIT_STAR)).toBe(true);
    expect(allowsBash(GIT_STATUS, GIT_STAR)).toBe(true);
    // ⚠️ This used to assert `false` with the comment "no space after git", and
    // that PINNED divergence #1 rather than catching it. The published table:
    // *"A `*` at the end, with a space before it, also matches the bare
    // command."* The space rule it was reaching for is a different one — it
    // makes `ls` a whole word, so `Bash(ls *)` still refuses `lsof` (asserted
    // in the next test) — and conflating the two is what kept the bug green.
    expect(allowsBash('git', GIT_STAR)).toBe(true);
  });

  it('wildcard anchoring: Bash(ls *) does NOT match lsof', () => {
    expect(allowsBash(LS_LA, LS_STAR)).toBe(true);
    expect(allowsBash(LSOF, LS_STAR)).toBe(false);
  });

  it('non-Bash rule does not match', () => {
    expect(allowsBash(NPM_RUN_LINT, 'Edit')).toBe(false);
    expect(allowsBash(NPM_RUN_LINT, 'Read(./.env)')).toBe(false);
  });

  it('normalises whitespace before matching', () => {
    expect(allowsBash('npm  run  lint', BASH_NPM_RUN_LINT)).toBe(true);
  });

  it('prefix rule matches base and base + args', () => {
    expect(allowsBash('npm run', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(allowsBash(NPM_RUN_LINT, BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(allowsBash('xargs npm run', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(allowsBash('xargs npm run lint', BASH_NPM_RUN_PREFIX)).toBe(true);
    expect(allowsBash('npm install', BASH_NPM_RUN_PREFIX)).toBe(false);
  });
});

describe('matchesPermissionRule', () => {
  it('bare Edit matches any Edit call', () => {
    expect(matchesAllowRule('Edit', '/some/file.ts', 'Edit')).toBe(true);
    expect(matchesAllowRule('Edit', '/any/path', 'Edit')).toBe(true);
  });

  it('wrong tool name does not match', () => {
    expect(matchesAllowRule('Bash', NPM_RUN_LINT, 'Edit')).toBe(false);
    expect(matchesAllowRule('Edit', '/file', 'Bash')).toBe(false);
  });

  it('tool names are case-sensitive', () => {
    expect(matchesAllowRule('bash', NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(false);
    expect(matchesAllowRule('Bash', NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(true);
  });

  // "Claude Code checks file permissions against `Edit(path)` and `Read(path)`
  //  rules only … accepts the rule but never consults it, and warns at startup."
  //
  // 🚩 We consulted path rules for six tools. Reporting a `Write(...)` deny rule
  // as blocking something Claude Code never checks is a wrong answer about an
  // adopter's config in the direction of over-reporting. `NotebookRead` was in
  // the set and is not in the doc's list at all.
  it('consults path rules for Read and Edit only', () => {
    const file = safePath.join(PLUGIN_DIR, SECRETS_KEY_RELATIVE);
    for (const tool of ['Read', 'Edit']) {
      expect(matchesAllowRule(tool, file, `${tool}(${SECRETS_PATTERN})`, PLUGIN_DIR)).toBe(true);
    }
    for (const tool of ['Write', 'Glob', 'NotebookRead', 'NotebookEdit']) {
      expect(matchesAllowRule(tool, file, `${tool}(${SECRETS_PATTERN})`, PLUGIN_DIR)).toBe(false);
    }
  });

  // A bare `Write` denies the TOOL and still matches — the carve-out is about
  // rules that carry a path. `Write(*)` carries one, so it is accepted and never
  // consulted, and reporting it as blocking anything would be a wrong answer.
  it('still honours a bare rule for a tool whose path rules are never consulted', () => {
    expect(matchesAllowRule('Write', '/any/file', 'Write')).toBe(true);
    expect(matchesAllowRule('Write', '/any/file', 'Write(*)')).toBe(false);
  });
});

// 🚩 This lane had NO tests at all, which is how the defect below survived.
describe('matchesPathRule', () => {
  // `matchesPathRule` takes an explicit `cwd`, then computed the relative path
  // with `safePath.relative(root, filePath)`. Node resolves a RELATIVE filePath
  // against `process.cwd()`, not against `root` — so the answer depended on
  // where the process happened to be launched. Its only production caller passes
  // the plugin directory, which is never `process.cwd()`, so the path lane of
  // the deny check returned false for everything.
  it('resolves a relative file path against the cwd it was GIVEN', () => {
    expect(matchesPathRule(SECRETS_KEY, SECRETS_PATTERN, PLUGIN_DIR)).toBe(true);
    expect(matchesPathRule(SECRETS_KEY_RELATIVE, SECRETS_PATTERN, PLUGIN_DIR)).toBe(true);
    expect(matchesPathRule('./public/readme.md', SECRETS_PATTERN, PLUGIN_DIR)).toBe(false);
  });

  // The consequence worth pinning: the verdict must not move when the process
  // is launched somewhere else. Two unrelated roots, same relative path.
  it('gives the same verdict regardless of where the process was launched', () => {
    const other = safePath.join(normalizedTmpdir(), 'vat-permission-matcher-elsewhere');
    expect(matchesPathRule(SECRETS_KEY, SECRETS_PATTERN, PLUGIN_DIR)).toBe(
      matchesPathRule(SECRETS_KEY, SECRETS_PATTERN, other),
    );
  });

  it('still handles an absolute file path under and outside the root', () => {
    expect(matchesPathRule(safePath.join(PLUGIN_DIR, SECRETS_KEY_RELATIVE), SECRETS_PATTERN, PLUGIN_DIR)).toBe(true);
    expect(
      matchesPathRule(safePath.join(normalizedTmpdir(), 'somewhere-else/secrets/key'), SECRETS_PATTERN, PLUGIN_DIR),
    ).toBe(false);
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
    expect(allowsBash('ls', LS_STAR)).toBe(true);
    expect(isSubsumedBy('Bash(ls)', LS_STAR)).toBe(true);
  });

  // 🚩 THE SOUNDNESS INVARIANT, and the only one that matters here.
  //
  // `settings-conflict-analyzer` turns `isSubsumedBy(narrow, broad) === true`
  // into user-facing advice to DELETE `narrow`. So the property to hold is not
  // "isSubsumedBy agrees with matchesBashRule" — that formulation is satisfied
  // by the very bug this catches, because `allowsBash('npm test *',
  // 'Bash(npm * *)')` tests the rule TEXT as a command and answers true. The
  // property is: **if we advise deleting a rule, no command may lose
  // permission.** `Bash(npm test *)` was reported redundant under
  // `Bash(npm * *)`, and deleting it silently revoked bare `npm test`, which a
  // two-wildcard rule does not permit.
  //
  // Checked over every ordered pair of the rule corpus, so a future rule shape
  // is covered without anyone adding a case.
  const RULE_CORPUS = [
    'Bash(npm * *)', 'Bash(npm test *)', 'Bash(npm *)', BASH_NPM_RUN_PREFIX,
    BASH_NPM_RUN_LINT, GIT_STAR, GIT_PUSH_STAR, LS_STAR, 'Bash(ls)',
    'Bash(cd *)', 'Bash(builtin cd)', 'Bash(grep *)', 'Bash(*)', 'Bash',
  ];
  const COMMAND_CORPUS = [
    'npm', 'npm test', 'npm test x', NPM_RUN_LINT, 'npm run', 'git', GIT_STATUS,
    GIT_PUSH_ORIGIN_MAIN, 'ls', LS_LA, LSOF, 'cd', 'cd /tmp', 'builtin cd',
    'nice -n 5 npm test', 'xargs grep p', 'grep p', 'echo hi',
  ];

  it('never advises deleting a rule that permits a command the broad rule does not', () => {
    const unsound: string[] = [];
    for (const narrow of RULE_CORPUS) {
      for (const broad of RULE_CORPUS) {
        if (narrow === broad || !isSubsumedBy(narrow, broad)) continue;
        for (const command of COMMAND_CORPUS) {
          if (allowsBash(command, narrow) && !allowsBash(command, broad)) {
            unsound.push(`${narrow} reported redundant under ${broad}, but loses "${command}"`);
          }
        }
      }
    }
    expect(unsound).toEqual([]);
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

  // 🚩 A backslash in the rule used to survive unescaped into the compiled
  // regex, so `\b` became a word boundary and `Bash(a\b *)` permitted `a b`.
  // Every Windows path in a rule compiled to something other than itself.
  it('escapes a backslash in the rule rather than compiling it as an escape', () => {
    expect(allowsBash('a b', String.raw`Bash(a\b *)`)).toBe(false);
    expect(allowsBash(String.raw`a\b c`, String.raw`Bash(a\b *)`)).toBe(true);
    for (const sequence of [String.raw`\d`, String.raw`\s`, String.raw`\w`, String.raw`\B`]) {
      expect(allowsBash('a1 c', `Bash(a${sequence} *)`)).toBe(false);
    }
  });

  // `\*` is a literal star, not a wildcard — the behaviour a dead identity
  // `.replaceAll('\\*', '\\*')` claimed to provide.
  it('treats an escaped star as a literal star', () => {
    expect(allowsBash('a* c', String.raw`Bash(a\* *)`)).toBe(true);
    expect(allowsBash('ax c', String.raw`Bash(a\* *)`)).toBe(false);
  });

  // 🚩 Adjacent `.*` backtrack polynomially, and both inputs are attacker-
  // reachable files this auditor reads (a settings.json permission, a SKILL.md
  // allowed-tools entry). Measured on the uncollapsed form, `Bash(a**********z)`
  // against `a` + n×`b`: n=20 → 228 ms, n=24 → 314 ms, n=28 → 1087 ms.
  //
  // Asserted on the regex SHAPE, not on a stopwatch: a duration threshold in a
  // unit test adds a second, machine-decided requirement and goes red under
  // load rather than on a regression.
  it('collapses a run of wildcards to a single .*', () => {
    const parsed = parseBashRuleContent('a**********z');
    expect(parsed.regex?.source).toBe('^a.*z$');
    expect(parsed.regex?.test('a' + 'b'.repeat(28) + 'z')).toBe(true);
    // A run of wildcards permits exactly what one wildcard permits.
    expect(parsed.regex?.test('a' + 'b'.repeat(28))).toBe(false);
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
    expect(allowsBash('ls', LS_STAR)).toBe(true);
    expect(allowsBash('git log', 'Bash(git log *)')).toBe(true);
  });

  // "That holds only when the trailing `*` is the rule's only wildcard:
  //  `Bash(* --help *)` matches `npm --help x` but not `npm --help`."
  it('does not match the bare command when another wildcard is present', () => {
    expect(allowsBash(NPM_HELP_X, HELP_STAR)).toBe(true);
    expect(allowsBash(NPM_HELP, HELP_STAR)).toBe(false);
  });

  // "The space before a trailing `*` is part of the rule. `Bash(ls *)` requires
  //  a space after `ls`, so `lsof` doesn't match. `Bash(ls*)` has no space, so
  //  it matches `lsof` too."
  it('honours the space before a trailing wildcard', () => {
    expect(allowsBash(LS_LA, LS_STAR)).toBe(true);
    expect(allowsBash(LSOF, LS_STAR)).toBe(false);
    expect(allowsBash(LSOF, LS_GLUED)).toBe(true);
    expect(allowsBash(LS_LA, LS_GLUED)).toBe(true);
  });

  // "The `:*` suffix is an equivalent way to write a trailing wildcard, so
  //  `Bash(ls:*)` matches the same commands as `Bash(ls *)`."
  // 🚩 The equivalence held only for rules with no OTHER wildcard, because the
  // `:*` spelling routed to a matcher that compared its base LITERALLY — so any
  // `*` earlier in the rule stayed a `*` character instead of becoming a
  // wildcard. Two spellings the table calls equivalent gave different answers.
  it('honours ":*" equivalence when the rule has another wildcard too', () => {
    const command = 'gitx push origin main x';
    expect(allowsBash(command, 'Bash(gitx * main *)')).toBe(true);
    expect(allowsBash(command, 'Bash(gitx * main:*)')).toBe(true);
    // And they must still agree when the answer is no.
    expect(allowsBash('gitx push origin other x', 'Bash(gitx * main *)')).toBe(false);
    expect(allowsBash('gitx push origin other x', 'Bash(gitx * main:*)')).toBe(false);
  });

  // The other half of the same divergence: the bare-command permit is granted
  // only when the trailing wildcard is the rule's ONLY one. The `:*` branch
  // granted it unconditionally, so `Bash(* --help:*)` permitted a bare
  // `npm --help` that the table's own worked example refuses.
  it('applies the only-wildcard restriction to ":*" as well', () => {
    expect(allowsBash(NPM_HELP, HELP_STAR)).toBe(false);
    expect(allowsBash(NPM_HELP, HELP_PREFIX)).toBe(false);
    expect(allowsBash(NPM_HELP_X, HELP_STAR)).toBe(true);
    expect(allowsBash(NPM_HELP_X, HELP_PREFIX)).toBe(true);
  });

  it('treats ":*" as equivalent to a trailing " *"', () => {
    for (const command of ['ls', LS_LA]) {
      expect(allowsBash(command, 'Bash(ls:*)')).toBe(allowsBash(command, LS_STAR));
    }
    expect(allowsBash(LSOF, 'Bash(ls:*)')).toBe(false);
  });
});

describe('published table — compound commands', () => {
  // "a rule like `Bash(safe-cmd *)` won't give it permission to run the command
  //  `safe-cmd && other-cmd`. The recognized command separators are `&&`, `||`,
  //  `;`, `|`, `|&`, `&`, and newlines. A rule must match each subcommand
  //  independently."
  it('refuses a compound command when a subcommand does not match', () => {
    expect(allowsBash('safe-cmd && other-cmd', SAFE_CMD_STAR)).toBe(false);
  });

  it('recognises every documented separator', () => {
    for (const sep of ['&&', '||', ';', '|', '|&', '&', '\n']) {
      expect(allowsBash(`safe-cmd ${sep} other-cmd`, SAFE_CMD_STAR)).toBe(false);
    }
  });

  it('allows a compound command when every subcommand matches', () => {
    expect(allowsBash('npm test && npm run lint', NPM_STAR)).toBe(true);
  });

  // "When `&&` or `||` has nothing after it, such as in `npm test &&`, Claude
  //  Code treats the command as unparseable and doesn't split it into
  //  subcommands for allow-rule matching, so a rule such as `Bash(npm *)`
  //  doesn't approve it."
  it('treats a dangling operator as unparseable', () => {
    expect(allowsBash('npm test &&', NPM_STAR)).toBe(false);
    expect(allowsBash('npm test ||', NPM_STAR)).toBe(false);
  });

  // A trailing `;` is ordinary shell, not the unparseable form the table names.
  it('does not treat a trailing ";" as unparseable', () => {
    expect(allowsBash('npm test;', NPM_STAR)).toBe(true);
  });

  // 🚩 Regression guard for a defect introduced WITH the compound splitting and
  // caught in review: the first implementation split with a regex, which is
  // blind to quoting, so `grep -E "a|b" file` split at the `|` inside the
  // quotes and left `b" file` as a subcommand no rule matches. Quoted
  // separators are far too common to break.
  it('does not split on a separator inside quotes', () => {
    expect(allowsBash('grep -E "a|b" file', GREP_STAR)).toBe(true);
    expect(allowsBash("grep -E 'a&&b' file", GREP_STAR)).toBe(true);
    expect(allowsBash('git commit -m "fix: a && b"', 'Bash(git commit *)')).toBe(true);
    expect(allowsBash('echo "a; b"', ECHO_STAR)).toBe(true);
  });

  // Same class: a separator inside `$(…)` or `(…)` is not top level.
  //
  // ⛔ UNSOURCED — the one expectation in these `published table —` suites with
  // no quoted sentence behind it. The page's ONLY nesting statement is the
  // deny/ask one ("Deny and ask rules apply when any subcommand matches them,
  // including a command nested inside a subshell, a command substitution, or a
  // control-flow body"); it never says the ALLOW lane ignores nested commands.
  // Reading the ANY-vs-EVERY asymmetry (real) as also a descends-vs-doesn't
  // asymmetry (not stated) is an INFERENCE, and this assertion locks in the
  // permissive half of it: it is why `echo $(rm -rf /)` matches `Bash(echo *)`.
  // Do not cite this test as the source. Resolve it against the product.
  it('does not split inside a subshell or command substitution', () => {
    expect(allowsBash('echo $(ls | wc -l)', ECHO_STAR)).toBe(true);
  });

  // An escaped separator is a literal character, not a split point.
  it('does not split on an escaped separator', () => {
    expect(allowsBash(String.raw`echo a\&\&b`, ECHO_STAR)).toBe(true);
  });

  // 🚩 Every separator assertion above expects `false`, so they would all still
  // pass if the splitter refused every input it was given. These pin the
  // POSITIVE direction: the separator must actually split, and each side must
  // then be matched on its own.
  it('splits at a separator rather than refusing the whole command', () => {
    for (const sep of ['&&', '||', ';', '|', '|&', '\n']) {
      expect(allowsBash(`npm test ${sep} npm run lint`, NPM_STAR)).toBe(true);
      expect(allowsBash(`npm test ${sep} rm -rf /`, NPM_STAR)).toBe(false);
    }
  });

  // "When Claude Code can't fully parse a command, it asks for approval instead."
  //
  // 🚩 Both forms below were FALSE PERMITS: an unterminated quote made the
  // scanner treat the whole rest of the line as quoted, and an unbalanced `(`
  // held it at depth > 0 forever. Either way every later separator became
  // invisible and the rule's trailing wildcard swallowed whatever followed —
  // the `rm -rf /` in each of these was reported as permitted by an `echo` or
  // `npm` rule. Both "graceful degradations" degraded toward PERMITTING.
  it('treats an unterminated quote as unparseable', () => {
    expect(allowsBash("echo hi # don't\nrm -rf /", ECHO_STAR)).toBe(false);
    expect(allowsBash('echo "unclosed\nrm -rf /', ECHO_STAR)).toBe(false);
    expect(allowsBash(String.raw`echo $'a\'b' && rm -rf /`, ECHO_STAR)).toBe(false);
    // The control: the same first command with the apostrophe removed parses,
    // splits, and is refused on the merits rather than by luck.
    expect(allowsBash('echo hi # dont\nrm -rf /', ECHO_STAR)).toBe(false);
  });

  it('treats an unbalanced parenthesis as unparseable', () => {
    expect(allowsBash('npm test # (\nrm -rf /', NPM_STAR)).toBe(false);
    expect(allowsBash('echo $(ls\nrm -rf /', ECHO_STAR)).toBe(false);
  });

  // The refusal has to stay narrow: a balanced subshell and a closed quote are
  // still parseable, so the fix cannot be a blanket "refuse anything quoted".
  it('still parses balanced parens and closed quotes', () => {
    expect(allowsBash('echo (a; b)', ECHO_STAR)).toBe(true);
    expect(allowsBash("echo 'a; b' && echo c", ECHO_STAR)).toBe(true);
  });
});

describe('published table — wrappers', () => {
  // "Before matching Bash rules, Claude Code strips a fixed set of wrappers, so
  //  a rule like `Bash(npm test *)` also matches `timeout 30 npm test`. The
  //  stripped wrappers are `timeout`, `time`, `nice`, `nohup`, and `stdbuf`,
  //  plus the shell builtins `command` and `builtin`, and zsh's `noglob`."
  it('strips the documented wrappers', () => {
    expect(allowsBash('timeout 30 npm test', NPM_TEST_STAR)).toBe(true);
    for (const wrapper of ['time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']) {
      expect(allowsBash(`${wrapper} ${NPM_TEST}`, NPM_TEST_STAR)).toBe(true);
    }
  });

  // "Two related forms aren't stripped: the query form `command -v`, which looks
  //  up a command rather than running one, and zsh's `nocorrect`."
  it('does not strip "command -v" or "nocorrect"', () => {
    expect(allowsBash('command -v npm test', NPM_TEST_STAR)).toBe(false);
    expect(allowsBash('nocorrect npm test', NPM_TEST_STAR)).toBe(false);
  });

  // "Bare `xargs` is also stripped, so `Bash(grep *)` matches `xargs grep
  //  pattern`. Stripping applies only when `xargs` has no flags: an invocation
  //  like `xargs -n1 grep pattern` is matched as an `xargs` command."
  it('strips bare xargs but not xargs with flags', () => {
    expect(allowsBash('xargs grep pattern', GREP_STAR)).toBe(true);
    expect(allowsBash('xargs -n1 grep pattern', GREP_STAR)).toBe(false);
  });

  // 🚩 A flag's VALUE can land in the command position. `timeout -s ls 30 rm -rf /`
  // used to strip to `ls 30 rm -rf /`, so `Bash(ls *)` reported a FALSE PERMIT on
  // a command that runs `rm -rf /`. The heuristic cannot know a wrapper flag's
  // arity, so halting on the token right after a flag must strip nothing.
  it('does not strip to a wrapper flag own value', () => {
    expect(allowsBash('timeout -s ls 30 rm -rf /', LS_STAR)).toBe(false);
    expect(allowsBash('nice -n rm 5 npm test', 'Bash(rm *)')).toBe(false);
  });

  // The cost of that refusal, stated so it is not mistaken for a bug: a wrapper
  // flag with a non-numeric value now refuses rather than mis-strips.
  it('refuses rather than guesses when a wrapper flag takes a value', () => {
    expect(allowsBash('timeout -s KILL 30 npm test', NPM_TEST_STAR)).toBe(false);
    // The documented forms are unaffected — the halt lands after a duration.
    expect(allowsBash('timeout 30 npm test', NPM_TEST_STAR)).toBe(true);
    expect(allowsBash('nice -n 5 npm test', NPM_TEST_STAR)).toBe(true);
  });
});

// ============================================================================
// The allow/deny lane — F4, and its dependents F11, F12, F15
// ============================================================================
//
// The module is written for the ALLOW lane and its only production caller uses
// it for DENY. Matching is NOT symmetric, so every expectation below states the
// lane it is asserting, and every lane-sensitive case asserts BOTH answers — an
// implementation that returned the deny answer for the allow lane, or `true`
// for everything in the deny lane, has to go red.

const LANES = ['allow', 'deny', 'ask'] as const;
const BASH = 'Bash';
const CURL_PREFIX = 'Bash(curl:*)';
const RM_STAR = 'Bash(rm *)';
const GITX_CLEAN_STAR = 'Bash(gitx clean *)';
const CURL_COMPOUND = 'curl https://x && echo done';
const GITX_CLEAN_NESTED = 'echo "$(gitx clean -f)"';
const ASSIGNED_RM = 'FOO=bar rm -rf tmp/';
const WRAPPED_RM = 'timeout -s KILL 30 rm -rf tmp/';
const NPM_TEST_X = 'npm test x';
const MCP_TOOL = 'mcp__srv__tool';
const MCP_SRV_GLOB = 'mcp__srv__*';
const DOMAIN_EVIL = 'domain:evil.com';
const WEBFETCH = 'WebFetch';
const WEBFETCH_EVIL = 'WebFetch(domain:evil.com)';
const RM_RF_ROOT = 'rm -rf /';

describe('published table — the deny/ask lane', () => {
  // "Deny and ask rules apply when any subcommand matches them" — where an
  // allow rule "must match each subcommand independently".
  it('matches when ANY subcommand matches, where allow needs every', () => {
    expect(matchesPermissionRule(BASH, CURL_COMPOUND, CURL_PREFIX, 'deny')).toBe(true);
    expect(matchesPermissionRule(BASH, CURL_COMPOUND, CURL_PREFIX, 'ask')).toBe(true);
    expect(matchesPermissionRule(BASH, CURL_COMPOUND, CURL_PREFIX, 'allow')).toBe(false);
  });

  // "A deny or ask rule matches past any leading assignment."
  it('matches past any leading assignment', () => {
    expect(matchesPermissionRule(BASH, ASSIGNED_RM, RM_STAR, 'deny')).toBe(true);
    expect(matchesPermissionRule(BASH, `NODE_ENV=x ${ASSIGNED_RM}`, RM_STAR, 'deny')).toBe(true);
    expect(matchesPermissionRule(BASH, ASSIGNED_RM, RM_STAR, 'allow')).toBe(false);
  });

  // "…including a command nested inside a subshell, a command substitution, or
  //  a control-flow body."
  it('descends into a subshell, a command substitution and a control-flow body', () => {
    for (const command of [
      GITX_CLEAN_NESTED,
      'echo `gitx clean -f`',
      '(gitx clean -f)',
      'if true; then gitx clean -f; fi',
      'for f in a; do gitx clean -f; done',
    ]) {
      expect(matchesPermissionRule(BASH, command, GITX_CLEAN_STAR, 'deny')).toBe(true);
    }
  });

  // ⚠️ The ALLOW-lane half of nesting is UNDETERMINED (see the ⛔ UNSOURCED note
  // in the compound suite above). Only the deny half is published, so only the
  // deny half is asserted here.
  it('takes any wrapper-strip reading when the heuristic is ambiguous', () => {
    expect(matchesPermissionRule(BASH, WRAPPED_RM, RM_STAR, 'deny')).toBe(true);
    // The allow lane keeps its single conservative reading, so F5's false permit
    // stays closed and its documented cost stays paid.
    expect(matchesPermissionRule(BASH, 'timeout -s KILL 30 npm test', NPM_TEST_STAR, 'allow')).toBe(
      false,
    );
    expect(matchesPermissionRule(BASH, 'timeout -s ls 30 rm -rf /', LS_STAR, 'allow')).toBe(false);
  });

  it('falls back to the raw whole string when the command is unparseable', () => {
    // Approving an unparseable command is a false permit, so allow refuses.
    expect(matchesPermissionRule(BASH, 'curl https://x &&', CURL_PREFIX, 'allow')).toBe(false);
    // Reporting no conflict is the unsafe direction for a checker, so deny must
    // not go silent — it tests the rule against the raw string instead.
    expect(matchesPermissionRule(BASH, 'curl https://x &&', CURL_PREFIX, 'deny')).toBe(true);
    expect(matchesPermissionRule(BASH, "curl https://x # don't", CURL_PREFIX, 'deny')).toBe(true);
  });

  // 🚩 THE BLINDNESS GUARD. Every expectation above is `true` for deny, so a
  // deny lane that answered `true` unconditionally would satisfy all of them.
  // These are the negatives, asserted in every lane.
  it('does not match a command outside the rule, in any lane', () => {
    for (const lane of LANES) {
      expect(matchesPermissionRule(BASH, 'echo hi && ls -la', CURL_PREFIX, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, 'echo "$(ls -la)"', GITX_CLEAN_STAR, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, 'FOO=bar echo hi', RM_STAR, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, 'timeout -s KILL 30 echo hi', RM_STAR, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, 'gitx cleanup -f', GITX_CLEAN_STAR, lane)).toBe(false);
      expect(matchesPermissionRule('Edit', '/some/file', 'Read', lane)).toBe(false);
    }
  });

  // The table names deny and ask together in every clause, so they are one
  // behaviour, not two implementations that could drift.
  it('gives deny and ask the same answer', () => {
    const cases: Array<[string, string]> = [
      [CURL_COMPOUND, CURL_PREFIX],
      [ASSIGNED_RM, RM_STAR],
      [GITX_CLEAN_NESTED, GITX_CLEAN_STAR],
      [WRAPPED_RM, RM_STAR],
      ['echo hi && ls -la', CURL_PREFIX],
      ['gitx cleanup -f', GITX_CLEAN_STAR],
    ];
    for (const [command, rule] of cases) {
      expect(matchesPermissionRule(BASH, command, rule, 'ask')).toBe(
        matchesPermissionRule(BASH, command, rule, 'deny'),
      );
    }
  });

  it('threads the lane through matchesBashRule too', () => {
    expect(matchesBashRule(CURL_COMPOUND, CURL_PREFIX, 'deny')).toBe(true);
    expect(matchesBashRule(CURL_COMPOUND, CURL_PREFIX, 'allow')).toBe(false);
  });
});

describe('matchesAllowRule / matchesDenyRule', () => {
  it('bind the lane and otherwise behave like matchesPermissionRule', () => {
    expect(matchesDenyRule(BASH, CURL_COMPOUND, CURL_PREFIX)).toBe(true);
    expect(matchesAllowRule(BASH, CURL_COMPOUND, CURL_PREFIX)).toBe(false);
    expect(matchesDenyRule(BASH, ASSIGNED_RM, RM_STAR)).toBe(true);
    expect(matchesAllowRule(BASH, ASSIGNED_RM, RM_STAR)).toBe(false);
  });

  it('still take a cwd for the path lane', () => {
    const file = safePath.join(PLUGIN_DIR, SECRETS_KEY_RELATIVE);
    expect(matchesDenyRule('Read', file, `Read(${SECRETS_PATTERN})`, PLUGIN_DIR)).toBe(true);
    expect(matchesAllowRule('Read', file, `Read(${SECRETS_PATTERN})`, PLUGIN_DIR)).toBe(true);
  });
});

describe('published table — tool-name globs', () => {
  // Deny and ask accept a glob in the tool-name position; an allow rule accepts
  // one only after a literal `mcp__<server>__` prefix.
  it('deny and ask accept a glob in the tool-name position', () => {
    for (const lane of ['deny', 'ask'] as const) {
      expect(matchesPermissionRule(BASH, RM_RF_ROOT, '*', lane)).toBe(true);
      expect(matchesPermissionRule(MCP_TOOL, 'x', 'mcp__*', lane)).toBe(true);
      expect(matchesPermissionRule(MCP_TOOL, 'x', MCP_SRV_GLOB, lane)).toBe(true);
    }
  });

  it('allow accepts a glob only after a literal mcp__<server>__ prefix', () => {
    expect(matchesPermissionRule(MCP_TOOL, 'x', MCP_SRV_GLOB, 'allow')).toBe(true);
    expect(matchesPermissionRule(MCP_TOOL, 'x', 'mcp__*', 'allow')).toBe(false);
    expect(matchesPermissionRule(BASH, RM_RF_ROOT, '*', 'allow')).toBe(false);
  });

  // A glob is a glob, not a licence: it still has to match the tool name.
  it('refuses a glob that does not cover the tool name', () => {
    for (const lane of LANES) {
      expect(matchesPermissionRule('mcp__other__tool', 'x', MCP_SRV_GLOB, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, RM_RF_ROOT, 'Edit*', lane)).toBe(false);
    }
  });
});

describe('published table — WebFetch(domain:…)', () => {
  it('matches a domain rule against a domain tool input', () => {
    for (const lane of LANES) {
      expect(matchesPermissionRule(WEBFETCH, DOMAIN_EVIL, 'WebFetch(domain:*)', lane)).toBe(true);
      expect(matchesPermissionRule(WEBFETCH, DOMAIN_EVIL, WEBFETCH_EVIL, lane)).toBe(true);
      expect(matchesPermissionRule(WEBFETCH, 'domain:good.com', WEBFETCH_EVIL, lane)).toBe(false);
    }
  });
});

describe('published table — leading env assignment', () => {
  // "an allow rule strips a leading assignment of certain known-safe environment
  //  variables … won't match past an assignment of any other variable" — and the
  // page names exactly one of them, `NODE_ENV`.
  it('the allow lane strips the one published variable and no other', () => {
    expect(matchesPermissionRule(BASH, 'NODE_ENV=test npm test', NPM_TEST_STAR, 'allow')).toBe(true);
    expect(matchesPermissionRule(BASH, `FOO=bar ${NPM_TEST_X}`, NPM_TEST_STAR, 'allow')).toBe(false);
    expect(
      matchesPermissionRule(BASH, `NODE_ENV=test FOO=bar ${NPM_TEST_X}`, NPM_TEST_STAR, 'allow'),
    ).toBe(false);
  });

  it('the deny lane strips past any leading assignment', () => {
    expect(matchesPermissionRule(BASH, `FOO=bar ${NPM_TEST_X}`, NPM_TEST_STAR, 'deny')).toBe(true);
    expect(
      matchesPermissionRule(BASH, `NODE_ENV=test FOO=bar ${NPM_TEST_X}`, NPM_TEST_STAR, 'deny'),
    ).toBe(true);
  });
});
