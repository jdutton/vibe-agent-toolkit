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
  matchesBashRule,
  matchesPathRule,
  matchesPermissionRule,
  parseBashRuleContent,
  parsePermissionRule,
} from '../src/settings/permission-matcher.js';

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
      expect(matchesPermissionRule(tool, file, `${tool}(${SECRETS_PATTERN})`, PLUGIN_DIR)).toBe(true);
    }
    for (const tool of ['Write', 'Glob', 'NotebookRead', 'NotebookEdit']) {
      expect(matchesPermissionRule(tool, file, `${tool}(${SECRETS_PATTERN})`, PLUGIN_DIR)).toBe(false);
    }
  });

  // A bare `Write` denies the TOOL and still matches — the carve-out is about
  // rules that carry a path. `Write(*)` carries one, so it is accepted and never
  // consulted, and reporting it as blocking anything would be a wrong answer.
  it('still honours a bare rule for a tool whose path rules are never consulted', () => {
    expect(matchesPermissionRule('Write', '/any/file', 'Write')).toBe(true);
    expect(matchesPermissionRule('Write', '/any/file', 'Write(*)')).toBe(false);
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
    expect(matchesBashRule('ls', LS_STAR)).toBe(true);
    expect(isSubsumedBy('Bash(ls)', LS_STAR)).toBe(true);
  });

  // 🚩 THE SOUNDNESS INVARIANT, and the only one that matters here.
  //
  // `settings-conflict-analyzer` turns `isSubsumedBy(narrow, broad) === true`
  // into user-facing advice to DELETE `narrow`. So the property to hold is not
  // "isSubsumedBy agrees with matchesBashRule" — that formulation is satisfied
  // by the very bug this catches, because `matchesBashRule('npm test *',
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
          if (matchesBashRule(command, narrow) && !matchesBashRule(command, broad)) {
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
    expect(matchesBashRule('a b', String.raw`Bash(a\b *)`)).toBe(false);
    expect(matchesBashRule(String.raw`a\b c`, String.raw`Bash(a\b *)`)).toBe(true);
    for (const sequence of [String.raw`\d`, String.raw`\s`, String.raw`\w`, String.raw`\B`]) {
      expect(matchesBashRule('a1 c', `Bash(a${sequence} *)`)).toBe(false);
    }
  });

  // `\*` is a literal star, not a wildcard — the behaviour a dead identity
  // `.replaceAll('\\*', '\\*')` claimed to provide.
  it('treats an escaped star as a literal star', () => {
    expect(matchesBashRule('a* c', String.raw`Bash(a\* *)`)).toBe(true);
    expect(matchesBashRule('ax c', String.raw`Bash(a\* *)`)).toBe(false);
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
    expect(matchesBashRule('ls', LS_STAR)).toBe(true);
    expect(matchesBashRule('git log', 'Bash(git log *)')).toBe(true);
  });

  // "That holds only when the trailing `*` is the rule's only wildcard:
  //  `Bash(* --help *)` matches `npm --help x` but not `npm --help`."
  it('does not match the bare command when another wildcard is present', () => {
    expect(matchesBashRule(NPM_HELP_X, HELP_STAR)).toBe(true);
    expect(matchesBashRule(NPM_HELP, HELP_STAR)).toBe(false);
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
  // 🚩 The equivalence held only for rules with no OTHER wildcard, because the
  // `:*` spelling routed to a matcher that compared its base LITERALLY — so any
  // `*` earlier in the rule stayed a `*` character instead of becoming a
  // wildcard. Two spellings the table calls equivalent gave different answers.
  it('honours ":*" equivalence when the rule has another wildcard too', () => {
    const command = 'gitx push origin main x';
    expect(matchesBashRule(command, 'Bash(gitx * main *)')).toBe(true);
    expect(matchesBashRule(command, 'Bash(gitx * main:*)')).toBe(true);
    // And they must still agree when the answer is no.
    expect(matchesBashRule('gitx push origin other x', 'Bash(gitx * main *)')).toBe(false);
    expect(matchesBashRule('gitx push origin other x', 'Bash(gitx * main:*)')).toBe(false);
  });

  // The other half of the same divergence: the bare-command permit is granted
  // only when the trailing wildcard is the rule's ONLY one. The `:*` branch
  // granted it unconditionally, so `Bash(* --help:*)` permitted a bare
  // `npm --help` that the table's own worked example refuses.
  it('applies the only-wildcard restriction to ":*" as well', () => {
    expect(matchesBashRule(NPM_HELP, HELP_STAR)).toBe(false);
    expect(matchesBashRule(NPM_HELP, HELP_PREFIX)).toBe(false);
    expect(matchesBashRule(NPM_HELP_X, HELP_STAR)).toBe(true);
    expect(matchesBashRule(NPM_HELP_X, HELP_PREFIX)).toBe(true);
  });

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
    expect(matchesBashRule('echo $(ls | wc -l)', ECHO_STAR)).toBe(true);
  });

  // An escaped separator is a literal character, not a split point.
  it('does not split on an escaped separator', () => {
    expect(matchesBashRule(String.raw`echo a\&\&b`, ECHO_STAR)).toBe(true);
  });

  // 🚩 Every separator assertion above expects `false`, so they would all still
  // pass if the splitter refused every input it was given. These pin the
  // POSITIVE direction: the separator must actually split, and each side must
  // then be matched on its own.
  it('splits at a separator rather than refusing the whole command', () => {
    for (const sep of ['&&', '||', ';', '|', '|&', '\n']) {
      expect(matchesBashRule(`npm test ${sep} npm run lint`, NPM_STAR)).toBe(true);
      expect(matchesBashRule(`npm test ${sep} rm -rf /`, NPM_STAR)).toBe(false);
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
    expect(matchesBashRule("echo hi # don't\nrm -rf /", ECHO_STAR)).toBe(false);
    expect(matchesBashRule('echo "unclosed\nrm -rf /', ECHO_STAR)).toBe(false);
    expect(matchesBashRule(String.raw`echo $'a\'b' && rm -rf /`, ECHO_STAR)).toBe(false);
    // The control: the same first command with the apostrophe removed parses,
    // splits, and is refused on the merits rather than by luck.
    expect(matchesBashRule('echo hi # dont\nrm -rf /', ECHO_STAR)).toBe(false);
  });

  it('treats an unbalanced parenthesis as unparseable', () => {
    expect(matchesBashRule('npm test # (\nrm -rf /', NPM_STAR)).toBe(false);
    expect(matchesBashRule('echo $(ls\nrm -rf /', ECHO_STAR)).toBe(false);
  });

  // The refusal has to stay narrow: a balanced subshell and a closed quote are
  // still parseable, so the fix cannot be a blanket "refuse anything quoted".
  it('still parses balanced parens and closed quotes', () => {
    expect(matchesBashRule('echo (a; b)', ECHO_STAR)).toBe(true);
    expect(matchesBashRule("echo 'a; b' && echo c", ECHO_STAR)).toBe(true);
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

  // 🚩 A flag's VALUE can land in the command position. `timeout -s ls 30 rm -rf /`
  // used to strip to `ls 30 rm -rf /`, so `Bash(ls *)` reported a FALSE PERMIT on
  // a command that runs `rm -rf /`. The heuristic cannot know a wrapper flag's
  // arity, so halting on the token right after a flag must strip nothing.
  it('does not strip to a wrapper flag own value', () => {
    expect(matchesBashRule('timeout -s ls 30 rm -rf /', LS_STAR)).toBe(false);
    expect(matchesBashRule('nice -n rm 5 npm test', 'Bash(rm *)')).toBe(false);
  });

  // The cost of that refusal, stated so it is not mistaken for a bug: a wrapper
  // flag with a non-numeric value now refuses rather than mis-strips.
  it('refuses rather than guesses when a wrapper flag takes a value', () => {
    expect(matchesBashRule('timeout -s KILL 30 npm test', NPM_TEST_STAR)).toBe(false);
    // The documented forms are unaffected — the halt lands after a duration.
    expect(matchesBashRule('timeout 30 npm test', NPM_TEST_STAR)).toBe(true);
    expect(matchesBashRule('nice -n 5 npm test', NPM_TEST_STAR)).toBe(true);
  });
});
