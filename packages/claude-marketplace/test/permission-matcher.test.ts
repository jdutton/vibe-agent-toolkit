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
const RM_STAR = 'Bash(rm *)';
const A_STAR_B_STAR_Z = 'Bash(a*b*z)';
const A_STAR_Z = 'Bash(a*z)';
const GIT_ONELINE_STAR = 'Bash(git * --oneline *)';
// The wrapper form whose flag VALUE lands in the command position — two
// admissible readings, so the allow lane must take neither.
const WRAPPER_FLAG_VALUE_CMD = 'timeout -s ls 30 rm -rf /';
const LS_PREFIX = 'Bash(ls:*)';
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
  it('compiles a wildcard rule to the literal runs between its wildcards', () => {
    const parsed = parseBashRuleContent(NPM_RUN_STAR);
    expect(parsed.type).toBe(WILDCARD);
    expect(parsed.pattern?.segments).toEqual(['npm run ', '']);
    expect(allowsBash(NPM_RUN_LINT, BASH_NPM_RUN_STAR)).toBe(true);
    expect(allowsBash('npm run build', BASH_NPM_RUN_STAR)).toBe(true);
    expect(allowsBash('npm install', BASH_NPM_RUN_STAR)).toBe(false);
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

  // 🚩 This case was called "treats a run of wildcards as one wildcard", and it
  // cannot see that. Deleting the run-collapse in `compileWildcardPattern`
  // leaves every answer identical — measured at 0 divergences over 1.5M random
  // pairs — because an uncollapsed run only inserts EMPTY middle segments and
  // `indexOf('', position)` returns `position`. The collapse is an optimisation,
  // not a behaviour, and no test can pin it as one. What this case can assert,
  // and now says out loud, is the EQUIVALENCE: the two spellings answer alike.
  // Asserted on the answers, not on a compiled shape — see the cost suite below
  // for why the shape assertion that used to live here was worthless.
  it('answers a run of wildcards exactly as it answers a single wildcard', () => {
    expect(parseBashRuleContent('a**********z').type).toBe(WILDCARD);
    const runOfStars = 'Bash(a**********z)';
    const long = 'a' + 'b'.repeat(28);
    for (const command of ['az', `${long}z`, long, 'z', 'a z', 'zaz', 'a']) {
      expect(allowsBash(command, runOfStars)).toBe(allowsBash(command, A_STAR_Z));
    }
    // ...and the equivalence is not vacuous: both spellings answer both ways.
    expect(allowsBash(`${long}z`, runOfStars)).toBe(true);
    expect(allowsBash(long, runOfStars)).toBe(false);
  });
});

// ============================================================================
// Wildcard matching COST — the property a compiled-shape assertion stood in for
// ============================================================================
//
// 🚩 The assertion this replaces read `parsed.regex?.source === '^a.*z$'`. It was
// TRUE while the safety property it stood for was FALSE. Collapsing only a RUN
// of adjacent stars leaves wildcards SEPARATED BY LITERALS compiling to
// `^a.*b.*b.*…z$`, which backtracks exponentially, and the shape assertion could
// not see it because the shape it inspected is the one harmless case.
//
// Measured on the built module before the fix, rule `Bash(ab*b*b*b*b*b*b*b*z)`
// against `ab`+n×`b`+`c`: n=20 → 1.5 ms, n=24 → 52 ms, n=28 → 159 ms,
// n=32 → 437 ms (~2.7× per four characters), and a 61-character command took
// 26,273 ms. The ordinary-looking rule
// `Bash(npm * --registry * --registry * --registry * publish)` was polynomial on
// the same module: 420 chars → 2.6 ms, 836 → 32 ms, 1,668 → 798 ms, 3,332 →
// 12,504 ms. Both inputs are attacker-reachable files this auditor reads — a
// `settings.json` permission entry and a plugin `SKILL.md` `allowed-tools:`
// entry — and `vat audit` reaches this through `checkSettingsCompatibility`.
//
// Cost is asserted as a RATIO between two input sizes, never as a wall-clock
// budget: a millisecond literal is a second, machine-decided requirement that
// goes red under load rather than on a regression.

/**
 * The per-call cost of `run`, in milliseconds, averaged over as many calls as
 * fit in one sampling window.
 *
 * The window is a measurement FLOOR, not a budget — it exists so that a call far
 * below the clock's resolution is still timed against something larger than the
 * clock — and nothing asserts on it. Only a RATIO of two of these is asserted on.
 */
function perCallMs(run: () => void): number {
  const sampleWindowMs = 25;
  const started = performance.now();
  let calls = 0;
  let elapsed = 0;
  do {
    run();
    calls += 1;
    elapsed = performance.now() - started;
  } while (elapsed < sampleWindowMs);
  return elapsed / calls;
}

/**
 * How much more one call of `large` costs than one call of `small`.
 *
 * The two are sampled INTERLEAVED and the best round wins, which is what keeps
 * this from going red under machine load rather than on a regression. Machine
 * interference can only ever make a sample slower, never faster, so a ratio is
 * only ever inflated — by a slow `large` round or a lucky-fast `small` one.
 * Interleaving makes a noisy slice hit both sides of the same round, and taking
 * the minimum ratio across rounds discards the rounds where it did not. The
 * first round doubles as JIT warm-up and is discarded the same way.
 */
function costRatio(small: () => void, large: () => void): number {
  const rounds = 7;
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    const smallMs = perCallMs(small);
    const largeMs = perCallMs(large);
    best = Math.min(best, largeMs / smallMs);
  }
  return best;
}

// 4× the input, so a linear matcher lands at ~4× the cost or below (a failing
// prefix/suffix check short-circuits, which pulls it under). The regexes this
// replaced were 300×–1,800× over on the same pair.
const MAX_COST_RATIO_FOR_4X_INPUT = 8;

/** 4× the input must cost under {@link MAX_COST_RATIO_FOR_4X_INPUT}× the time. */
function expectLinearCost(small: () => void, large: () => void): void {
  expect(costRatio(small, large)).toBeLessThan(MAX_COST_RATIO_FOR_4X_INPUT);
}

/**
 * Both halves of one rule's cost claim: that 4× the command costs under
 * {@link MAX_COST_RATIO_FOR_4X_INPUT}× the time, AND that the command being
 * timed is still the SHAPE the caller says it is.
 *
 * 🚩 `answer` is the half that was missing, and its absence made both ratios
 * below vacuous. A command the matcher refuses on `startsWith`/`endsWith`
 * returns before the segment scan, so its ratio bounds two string comparisons
 * and nothing else — measured: injecting `for (let q = 0; q < text.length * 200;
 * q += 1)` into the segment loop left the whole suite green. Pinning the answer
 * pins which side of that short-circuit the timed call lands on, so a shape that
 * silently stops reaching the scan fails here instead of passing a ratio that
 * measures the wrong code.
 */
function expectLinearInCommand(
  rule: string,
  command: (n: number) => string,
  sizes: readonly [number, number],
  answer: boolean,
): void {
  const [small, large] = sizes;
  expect(allowsBash(command(large), rule)).toBe(answer);
  expectLinearCost(
    () => {
      matchesBashRule(command(small), rule, 'allow');
    },
    () => {
      matchesBashRule(command(large), rule, 'allow');
    },
  );
}

describe('wildcard matching cost is linear in the input', () => {
  it('does not blow up on wildcards separated by literals', () => {
    const rule = 'Bash(ab*b*b*b*b*b*b*b*z)';
    // 8 and 32 filler characters — 4× the part that grows.
    const sizes = [8, 32] as const;
    // REFUSED on the suffix, so the scan short-circuits. This is the input that
    // took the regex 26,273 ms, and it is the half that reds a regex
    // reintroduction — which is why it stays even though it stops early.
    expectLinearInCommand(rule, (n) => 'ab' + 'b'.repeat(n) + 'c', sizes, false);
    // PERMITTED, so all seven middle segments go through the scan. Without this
    // half the ratio above bounds `startsWith` and `endsWith` only.
    expectLinearInCommand(rule, (n) => 'ab' + 'b'.repeat(n) + 'z', sizes, true);
  });

  it('does not blow up on an ordinary rule carrying four wildcards', () => {
    const rule = 'Bash(npm * --registry * --registry * --registry * publish)';
    // 420 characters and 1,668: ~4×.
    const sizes = [32, 128] as const;
    const flags = (n: number): string => 'npm ' + ' --registry a'.repeat(n);
    expectLinearInCommand(rule, flags, sizes, false);
    // The same command with the suffix the rule wants, so the three middle
    // segments are searched for rather than skipped.
    expectLinearInCommand(rule, (n) => `${flags(n)} publish`, sizes, true);
  });

  // 🚩 Neither ratio above can see work done INSIDE the segment loop, and no
  // choice of sizes would let them: both rules carry a FIXED number of segments,
  // so per-segment work proportional to the command is still LINEAR in the
  // command, and a ratio is blind to a constant factor by construction.
  //
  // The rule is attacker-supplied too — a `settings.json` entry, a `SKILL.md`
  // `allowed-tools:` entry — so the honest input is one where the rule and the
  // command grow together. There the same injected loop is quadratic, and this
  // ratio does see it: measured at 15.9× against a bound of 8.
  it('stays linear when the rule and the command grow together', () => {
    const rule = (n: number): string => `Bash(a${'*b'.repeat(n)}*z)`;
    const command = (n: number): string => 'a' + 'b'.repeat(n) + 'z';
    // The blindness guard: every one of the n middle segments has to be found,
    // and one character short of enough is still refused.
    expect(matchesBashRule(command(1000), rule(1000), 'allow')).toBe(true);
    expect(matchesBashRule(command(999), rule(1000), 'allow')).toBe(false);
    expectLinearCost(
      () => {
        matchesBashRule(command(250), rule(250), 'allow');
      },
      () => {
        matchesBashRule(command(1000), rule(1000), 'allow');
      },
    );
  });

  // 🚩 The blindness guard for the two above: a matcher that answered `false`
  // in O(1) for everything would satisfy both ratios. These pin that a glob with
  // wildcards separated by literals still matches what it should, including the
  // overlap case a greedy scan can get wrong.
  it('still answers correctly with wildcards separated by literals', () => {
    expect(allowsBash('a1b2z', A_STAR_B_STAR_Z)).toBe(true);
    expect(allowsBash('abz', A_STAR_B_STAR_Z)).toBe(true);
    expect(allowsBash('az', A_STAR_B_STAR_Z)).toBe(false);
    expect(allowsBash('a1b2y', A_STAR_B_STAR_Z)).toBe(false);
    // The middle literal has to be found at a position that still leaves room
    // for the suffix: `a*ab*b` needs four characters, not three.
    expect(allowsBash('aab', 'Bash(a*ab*b)')).toBe(false);
    expect(allowsBash('aabb', 'Bash(a*ab*b)')).toBe(true);
    // A wildcard spans spaces, and the anchors are both ends of the command.
    expect(allowsBash('git log --oneline main', GIT_ONELINE_STAR)).toBe(true);
    expect(allowsBash('git log --oneline', GIT_ONELINE_STAR)).toBe(false);
  });

  // 🚩 The same class one layer down, and reached by the same attacker-supplied
  // input: the deny lane emitted every ENCLOSING nested region whole and split
  // each of them, so the work was quadratic in the nesting depth even though
  // each region's own text is read only once. Measured on the shipped module,
  // `'('×k + 'echo x' + ')'×k` against `Bash(rm *)`: k=25,000 → 4,487 ms, with 4×
  // the length costing ~11× the time.
  it('does not blow up on deeply nested regions in the deny lane', () => {
    const command = (depth: number): string =>
      '('.repeat(depth) + 'echo x' + ')'.repeat(depth);
    const ratio = costRatio(
      () => {
        matchesDenyRule(BASH, command(3000), RM_STAR);
      },
      () => {
        matchesDenyRule(BASH, command(12_000), RM_STAR);
      },
    );
    expect(ratio).toBeLessThan(MAX_COST_RATIO_FOR_4X_INPUT);
  });

  // 🚩 The blindness guard for the ratio above: a `nestedRegions` that returned
  // nothing would be linear and pass. The deny lane still has to analyse the
  // whole nest whenever the budget covers it — a `true` AND a `false` at a depth
  // where nothing is dropped, so neither answer can be the constant one.
  //
  // ⚠️ The depth is 10 and that is deliberate. This shape's regions sum to
  // roughly depth², against a budget linear in the command's length, so it stops
  // being analysed in full somewhere past a depth of 13 — and past that point
  // the lane FAILS CLOSED and answers `true` for everything, which would make
  // both assertions below vacuous. See the budget suite for the other side.
  it('analyses a nest in full at every depth the budget covers', () => {
    const depth = 10;
    expect(matchesDenyRule(BASH, '('.repeat(depth) + 'rm -rf tmp' + ')'.repeat(depth), RM_STAR))
      .toBe(true);
    expect(matchesDenyRule(BASH, '('.repeat(depth) + 'echo x' + ')'.repeat(depth), RM_STAR))
      .toBe(false);
  });
});

// ============================================================================
// The region budget's SAFETY direction
// ============================================================================

/**
 * A nest `depth` regions deep whose `payload` sits in the own-text of the region
 * at `level` — 0 being the OUTERMOST region, `depth - 1` the innermost.
 *
 * The level is the whole point. {@link closeRegion}'s budget is spent
 * innermost-first, because regions close from the inside out, so the regions it
 * drops are the OUTER ones — and an outer region's own text is a place a command
 * can sit, outside every child.
 */
function nestWithPayloadAt(depth: number, level: number, payload: string): string {
  const children = depth - level - 1;
  const inner = '('.repeat(children) + ')'.repeat(children);
  return `${'('.repeat(level + 1)} ${inner} ; ${payload} ${')'.repeat(level + 1)}`;
}

describe('the nested-region budget fails closed', () => {
  // 🚩 THE FINDING, from the review: a sixty-odd character command, twenty-odd
  // levels, and the payload in the OUTER region. `matchesDenyRule` answered
  // `false` — an UNDER-REPORT, the direction this module's own header calls the
  // unsafe one, reachable from a plugin's `allowed-tools:` content.
  //
  // The guard that existed put its command at the INNERMOST point, which is the
  // one position the innermost-first spend always preserves, so it could not see
  // this. A budget that drops work must drop it into `true`, never into `false`.
  //
  // Measured on the pre-fix module: `false` from 22 levels up, `true` below it.
  // Both sides of that boundary are asserted, so a fix that merely MOVED it goes
  // red rather than passing on the shallower row.
  it.each([21, 22, 23])('reports a %i-level nest whose payload the budget drops', (depth) => {
    const command = `x $( ${'('.repeat(depth)}${')'.repeat(depth)} ; ${RM_RF_ROOT} )`;
    expect(matchesDenyRule(BASH, command, RM_STAR)).toBe(true);
  });

  // The mechanism rather than that one instance: the payload at EVERY level of
  // the nest, at depths either side of where the budget binds. A spend that
  // preserves only part of the nest has to be invisible in the ANSWER.
  it('reports a denied command at every level of a nest, at every depth', () => {
    for (const depth of [1, 3, 12, 23, 40, 200]) {
      for (let level = 0; level < depth; level += 1) {
        const command = nestWithPayloadAt(depth, level, RM_RF_ROOT);
        expect(matchesDenyRule(BASH, command, RM_STAR), `depth=${depth} level=${level}`).toBe(true);
      }
    }
  });

  // …and what that costs, stated rather than discovered. Past the budget the
  // lane cannot say what the command contains, so it says `true` — including for
  // a command that contains nothing of the kind. This is also the blindness
  // guard for the cost ratio above: a `nestedRegions` that emitted nothing would
  // never exhaust its budget and would answer `false` here.
  it('over-reports an innocent command once the budget is exhausted', () => {
    const innocent = '('.repeat(3000) + 'echo x' + ')'.repeat(3000);
    expect(matchesDenyRule(BASH, innocent, RM_STAR)).toBe(true);
    // ⛔ The ALLOW lane is untouched: it never builds nested regions, so it has
    // no budget to exhaust and must not start permitting on exhaustion.
    expect(matchesAllowRule(BASH, innocent, RM_STAR)).toBe(false);
  });
});

// ============================================================================
// The greedy scan's own invariants
// ============================================================================
//
// The two-pointer scan in `matchesWildcardPattern` makes two decisions that no
// conformance case above can see, because the published table never puts a rule
// of either shape in front of it. Both were provably deletable: removing either
// left the whole suite green, and both deletions are WIDER or WRONGER answers.

/**
 * The shortest string that both starts with `prefix` and ends with `suffix`.
 *
 * Shorter than the two laid end to end exactly when they overlap, which is the
 * whole point: it is the witness a rule `prefix*suffix` must refuse, and the one
 * a matcher that forgets the prefix and the suffix may not share characters
 * wrongly permits.
 */
function maximalOverlapJoin(prefix: string, suffix: string): string {
  for (let overlap = Math.min(prefix.length, suffix.length); overlap > 0; overlap -= 1) {
    if (prefix.endsWith(suffix.slice(0, overlap))) return prefix + suffix.slice(overlap);
  }
  return prefix + suffix;
}

describe('wildcard matching — the greedy scan', () => {
  // 🚩 `if (limit < position) return false` is the ONLY thing standing between
  // `Bash(rm*rm)` and a permit for the bare command `rm`. Deleting that one line
  // left 87/87 green while widening every overlapping rule in the allow lane:
  // `Bash(a*a)` permitted `a`, `Bash(echo*echo)` permitted `echo`. Direction =
  // WIDER = false permit, so this is the one place a reintroduction is a
  // security defect rather than a wrong answer.
  //
  // Pinned as the PROPERTY — a command too short to contain both anchors is
  // refused — over six shapes, not as the `a*a` example that found it.
  it('refuses a command too short to hold both the prefix and the suffix', () => {
    const overlapping = [
      ['a', 'a'],
      ['rm', 'rm'],
      ['echo', 'echo'],
      ['abc', 'bcd'],
      ['ls -l', '-la'],
      ['npm run', 'run publish'],
    ] as const;

    for (const [prefix, suffix] of overlapping) {
      const rule = `Bash(${prefix}*${suffix})`;
      const tooShort = maximalOverlapJoin(prefix, suffix);
      // The witness is only a witness while it is genuinely too short and still
      // carries both anchors — otherwise the refusal below proves nothing.
      expect(tooShort.length).toBeLessThan(prefix.length + suffix.length);
      expect(tooShort.startsWith(prefix) && tooShort.endsWith(suffix)).toBe(true);
      expect(allowsBash(tooShort, rule)).toBe(false);
      // ...and the same rule still permits what it does express, so the refusal
      // above is not a matcher that answers `false` to everything.
      expect(allowsBash(prefix + suffix, rule)).toBe(true);
      expect(allowsBash(`${prefix}x${suffix}`, rule)).toBe(true);
    }
  });

  // 🚩 The scan's DIRECTION was untested: swapping `indexOf(segment, position)`
  // for `lastIndexOf(segment)` left 87/87 green and is defective — taking a
  // middle segment later than it has to can only leave less room for the
  // segments after it, so the earliest occurrence is the only correct choice.
  //
  // Every case here is `prefix*middle*suffix` with a suffix that STARTS with the
  // middle segment, so the middle segment occurs twice and only its earlier
  // occurrence leaves room for the suffix.
  it('takes a middle segment at its earliest admissible occurrence, not its latest', () => {
    const shapes = [
      ['a', 'b', 'bz'],
      ['npm run', ' build', ' build --x'],
      ['x', 'yz', 'yzw'],
    ] as const;

    for (const [prefix, middle, suffix] of shapes) {
      const rule = `Bash(${prefix}*${middle}*${suffix})`;
      expect(suffix.startsWith(middle)).toBe(true); // The witness is a witness.
      expect(allowsBash(prefix + middle + suffix, rule)).toBe(true);
      // ...and a command carrying only ONE occurrence still has nowhere to put
      // the middle segment, so the permit above is not a blanket `true`.
      expect(allowsBash(prefix + suffix, rule)).toBe(false);
    }
  });

  // The other half of the same line: the search starts at `position`, never at
  // 0. Dropping the position argument from `indexOf` also left 87/87 green, and
  // it lets a middle segment be "found" inside the PREFIX it must follow —
  // `Bash(git log*log* --oneline)` would permit `git log --oneline`, which
  // contains the word `log` exactly once.
  it('will not satisfy a middle segment from inside the prefix', () => {
    const shapes = [
      ['a', 'a', 'z'],
      ['rm ', 'rm', '-rf'],
      ['git log', 'log', ' --oneline'],
    ] as const;

    for (const [prefix, middle, suffix] of shapes) {
      const rule = `Bash(${prefix}*${middle}*${suffix})`;
      expect(prefix.includes(middle)).toBe(true); // The witness is a witness.
      expect(allowsBash(prefix + suffix, rule)).toBe(false);
      // ...and a command that really does carry the middle segment after the
      // prefix is still permitted.
      expect(allowsBash(prefix + middle + suffix, rule)).toBe(true);
    }
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
      expect(allowsBash(command, LS_PREFIX)).toBe(allowsBash(command, LS_STAR));
    }
    expect(allowsBash(LSOF, LS_PREFIX)).toBe(false);
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
    expect(allowsBash(WRAPPER_FLAG_VALUE_CMD, LS_STAR)).toBe(false);
    expect(allowsBash('nice -n rm 5 npm test', RM_STAR)).toBe(false);
  });

  // The cost of that refusal, stated so it is not mistaken for a bug: a wrapper
  // flag with a non-numeric value now refuses rather than mis-strips.
  it('refuses rather than guesses when a wrapper flag takes a value', () => {
    expect(allowsBash('timeout -s KILL 30 npm test', NPM_TEST_STAR)).toBe(false);
    // The documented forms are unaffected — the halt lands after a duration.
    expect(allowsBash('timeout 30 npm test', NPM_TEST_STAR)).toBe(true);
    expect(allowsBash('nice -n 5 npm test', NPM_TEST_STAR)).toBe(true);
  });

  // ⚠️ CHARACTERIZATION. This pins the real edge of the wrapper heuristic, which
  // the module header used to describe wrongly: it claimed the allow lane was
  // "byte-for-byte" the pre-lane behaviour apart from the `NODE_ENV` strip. A
  // 270,855-pair differential says otherwise — 1,219 divergences, 776 of them
  // old=false→new=true, of which 736 are the `NODE_ENV` strip and 40 are THESE.
  //
  // 🔑 The behaviour is right and stays. `wrapperCommandStarts` returns a SINGLE
  // reading when the resumed reading would run off the end of the token list, so
  // the ambiguity only ever arises with the ambiguous token LAST — where the
  // alternative reading is "the flag ate it and no command runs at all", and a
  // permit cannot be wrong about a command that does not exist. The false permit
  // this guards against has the other shape, and is asserted right below.
  it('strips when the ambiguous token is LAST, and refuses when it is not', () => {
    for (const command of ['timeout 30 -rf test', 'nice -n 5 -rf test', 'command -rf test']) {
      expect(allowsBash(command, 'Bash(test *)')).toBe(true);
    }
    // Two admissible readings, so the allow lane takes neither.
    expect(allowsBash(WRAPPER_FLAG_VALUE_CMD, LS_STAR)).toBe(false);
    expect(allowsBash('nice -n rm 5 npm test', RM_STAR)).toBe(false);
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
// A subshell whose own child region sits INSIDE the rule literal — the shape the
// nested-region placeholder used to erase. See the case that pins it.
const SUBSHELL_RM_PWD = '(rm -rf $(pwd))';
const BASH_RM_PWD = 'Bash(rm -rf $(pwd))';

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

  // 🚩 An enclosing region used to carry a two-character placeholder in place of
  // each of its own nested regions, justified as *"a region that has already
  // been emitted on its own does not need to appear inside its parent as well."*
  // That justification is FALSE for every rule whose literal SPANS the child:
  // `Bash(rm -rf $(pwd))` saw `rm -rf $()` and answered `false` for
  // `(rm -rf $(pwd))`. Direction = UNDER-REPORT — `vat audit` says "no conflict"
  // about a command Claude Code blocks — which is the same class the
  // unparseable-command fallback two hunks away exists to close.
  //
  // Pinned as the PROPERTY: a region is the command's own text, so a rule
  // literal that crosses a nested region's boundary still matches.
  it('reaches a rule literal that spans a nested region', () => {
    const backtick = String.fromCodePoint(0x60);
    const cases: Array<[string, string]> = [
      [SUBSHELL_RM_PWD, BASH_RM_PWD],
      ['(sh -c "rm $(x)")', 'Bash(sh -c "rm $(x)")'],
      [`${backtick}echo $(x) done${backtick}`, 'Bash(echo $(x) done)'],
      [`$(rm -rf ${backtick}pwd${backtick})`, `Bash(rm -rf ${backtick}pwd${backtick})`],
      [`if true; then ${SUBSHELL_RM_PWD}; fi`, BASH_RM_PWD],
      ['echo "$(sh -c "rm $(x)")"', 'Bash(sh -c "rm $(x)")'],
      // Three deep, so the region-text budget has to cover more than one
      // generation of children before it binds.
      ['(rm -rf $(dirname $(pwd)))', 'Bash(rm -rf $(dirname $(pwd)))'],
    ];
    for (const [command, rule] of cases) {
      expect(matchesPermissionRule(BASH, command, rule, 'deny')).toBe(true);
      expect(matchesPermissionRule(BASH, command, rule, 'ask')).toBe(true);
      // ⛔ And the ALLOW lane does not widen with it: the table's only nesting
      // sentence is the deny/ask one.
      expect(matchesPermissionRule(BASH, command, rule, 'allow')).toBe(false);
    }
  });

  // 🚩 The blindness guard for the case above: a region carrying its children's
  // text verbatim must not start matching rules the command does not contain.
  it('does not invent a match from a nested region it now carries', () => {
    for (const lane of LANES) {
      expect(matchesPermissionRule(BASH, '(echo $(pwd))', BASH_RM_PWD, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, SUBSHELL_RM_PWD, 'Bash(rm -rf $(cwd))', lane)).toBe(false);
      expect(matchesPermissionRule(BASH, SUBSHELL_RM_PWD, ECHO_STAR, lane)).toBe(false);
    }
  });

  // 🚩 Nesting was implemented ONLY as "drop a leading control-flow KEYWORD", and
  // a `case` arm is introduced by a PATTERN and `)`, not by a keyword — so the
  // one body form the keyword list structurally cannot reach was the one form
  // that went unmatched, while every other (`if/then`, `while/do`, `for/do`,
  // `until/do`, `{ …; }`, `$(…)`, backticks, `(…)`, `<(…)`) passed. Observed:
  // `Bash(rm *)` vs `case x in x) rm -rf tmp;; esac` returned false.
  it('descends into a case arm, which no keyword introduces', () => {
    for (const command of [
      'case x in x) rm -rf tmp;; esac',
      'case "$1" in *) rm -rf tmp;; esac',
      // The POSIX spelling, where the arm pattern carries its own leading paren.
      'case x in (x) rm -rf tmp;; esac',
      // A later arm, which reaches denySegments without the `case` header.
      'case x in a) echo hi;; b) rm -rf tmp;; esac',
      // A function BODY arrives through the same reduction, because `foo()` is a
      // whitespace-free group — the same direction the published clause asks for.
      'foo() { rm -rf tmp; }',
    ]) {
      expect(matchesPermissionRule(BASH, command, RM_STAR, 'deny')).toBe(true);
      expect(matchesPermissionRule(BASH, command, RM_STAR, 'ask')).toBe(true);
    }
  });

  // 🚩 The precision guard for the arm reduction: a `)` is an arm terminator only
  // when it closes nothing, or closes a whitespace-free group that is not a `$(`.
  // Without that, `echo $(foo) rm` would report a conflict with `Bash(rm *)` over
  // an `echo` whose second ARGUMENT is the word `rm`, and a `)` inside a string
  // would do the same.
  it('does not read a closing paren as a case arm when it is not one', () => {
    for (const lane of LANES) {
      expect(matchesPermissionRule(BASH, 'echo $(foo) rm', RM_STAR, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, 'echo "a) rm -rf tmp"', RM_STAR, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, "echo 'a) rm -rf tmp'", RM_STAR, lane)).toBe(false);
      expect(matchesPermissionRule(BASH, 'case x in x) echo hi;; esac', RM_STAR, lane)).toBe(false);
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
    expect(matchesPermissionRule(BASH, WRAPPER_FLAG_VALUE_CMD, LS_STAR, 'allow')).toBe(false);
  });

  it('falls back to the raw whole string when the command is unparseable', () => {
    // Approving an unparseable command is a false permit, so allow refuses.
    expect(matchesPermissionRule(BASH, 'curl https://x &&', CURL_PREFIX, 'allow')).toBe(false);
    // Reporting no conflict is the unsafe direction for a checker, so deny must
    // not go silent — it tests the rule against the raw string instead.
    expect(matchesPermissionRule(BASH, 'curl https://x &&', CURL_PREFIX, 'deny')).toBe(true);
    expect(matchesPermissionRule(BASH, "curl https://x # don't", CURL_PREFIX, 'deny')).toBe(true);
  });

  // 🚩 …and the whole string is not ENOUGH. The fallback pushed the raw region as
  // ONE segment, so the rule had to match the entire command — which it almost
  // never does for the class the fallback exists for. The denied command in an
  // unparseable compound is not at the front: the very example the module quotes
  // as its worked false permit, `echo hi # don't⏎rm -rf /`, answered `false`
  // under `Bash(rm *)`, and so did `npm test # (⏎rm -rf /` and
  // `echo "unclosed⏎rm -rf /`. Only the case where the denied program leads
  // (`rm -rf tmp &&`) was caught. What makes these unparseable — an odd quote, an
  // unbalanced `(` — is exactly what hid the separator, so the fallback recovers
  // the separators the parser refused to trust.
  it('reaches a denied command that is not at the front of an unparseable command', () => {
    for (const command of [
      "echo hi # don't\nrm -rf /",
      'npm test # (\nrm -rf /',
      'echo "unclosed\nrm -rf /',
      'rm -rf tmp &&',
    ]) {
      expect(matchesPermissionRule(BASH, command, RM_STAR, 'deny')).toBe(true);
      expect(matchesPermissionRule(BASH, command, RM_STAR, 'ask')).toBe(true);
      // ⛔ The ALLOW lane must not widen with it. This is an UNDER-report being
      // fixed, not a false permit: Claude Code asks for approval on a command it
      // cannot parse, so allow keeps refusing every one of these.
      expect(matchesPermissionRule(BASH, command, RM_STAR, 'allow')).toBe(false);
    }
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

  // ⚖️ A DECISION, pinned so it stops being an accident. `*` in the tool-name
  // position spans EVERY character, newline included. The regex this lane used
  // to compile built `.*` with no `s` flag, so `.` silently excluded `\n` and
  // `mcp__srv__*` did NOT match `mcp__srv__a⏎b`; the glob scan has no such
  // exclusion and `matchesToolName` does not normalise whitespace, so the
  // behaviour changed without anyone choosing it.
  //
  // Keeping the new behaviour, because the exclusion is unsafe in the lane that
  // matters: `matchesToolName` serves all three lanes, so a newline-excluding
  // `*` would make a DENY rule covering a whole server report as not covering a
  // name plainly under it — the same under-report class this module has already
  // had to fix twice. On the allow side nothing widens that an operator did not
  // already grant, since the name is under a server they allow-listed by name.
  // Unreachable on the Bash lane either way: that lane normalises whitespace
  // before a tool name ever gets here.
  it('spans a newline in the tool-name position, in every lane', () => {
    const newline = String.fromCodePoint(0x0a);
    for (const lane of LANES) {
      expect(matchesPermissionRule(`mcp__srv__a${newline}b`, 'x', MCP_SRV_GLOB, lane)).toBe(true);
      // ...and the glob is still anchored on the literal before the `*`: a
      // newline does not smuggle a different server past the prefix.
      expect(matchesPermissionRule(`mcp__other__a${newline}b`, 'x', MCP_SRV_GLOB, lane)).toBe(
        false,
      );
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

const NPM_RUN_BUILD_PREFIX = 'Bash(npm run build:*)';
const NPM_RUN_BUILD = 'npm run build';
const DEV_NULL = '/dev/null';

/**
 * Every spelling of a redirection whose operator CONTAINS an `&`. The `&` in
 * each of these belongs to the redirection operator, not to a command
 * separator, so none of them may end a subcommand.
 */
const AMPERSAND_REDIRECTIONS = [
  '2>&1',
  '1>&2',
  '2>&-',
  '>&2',
  `&>${DEV_NULL}`,
  '&>>build.log',
  `>&${DEV_NULL}`,
];

/**
 * The `&` spellings that ARE separators — a background job (spaced, trailing
 * and glued) and the logical operator — so the fix cannot be "stop treating `&`
 * as a separator".
 */
const AMPERSAND_SEPARATORS = [' & ', ' &', '&', ' && '];

describe('published table — redirections vs the `&` separator', () => {
  // The file's own `@vendor-claim` names *"redirections vs the `&` separator"*
  // as a published clause with NO assertion behind it. This suite is that
  // assertion.
  //
  // 🚩 `ONE_CHAR_SEPARATORS` held `&` with no redirection awareness, so `2>&1`
  // split into `… 2>` and `1`, and the allow lane's every-subcommand
  // requirement then failed on the subcommand `1`. Same class as the
  // `grep -E "a|b"` quoting defect: an under-match, so the direction is safe,
  // but it broke the single most common shell idiom.
  it('does not split a command at the `&` inside a redirection', () => {
    for (const redirection of AMPERSAND_REDIRECTIONS) {
      expect(allowsBash(`${LS_LA} > ${DEV_NULL} ${redirection}`, LS_PREFIX)).toBe(true);
      expect(allowsBash(`${NPM_RUN_BUILD} ${redirection}`, NPM_RUN_BUILD_PREFIX)).toBe(true);
      expect(allowsBash(`${LS_LA} ${redirection}`, LS_STAR)).toBe(true);
    }
  });

  // 🚩 The negative direction, without which the suite above would pass on a
  // matcher that had simply stopped splitting on `&` altogether: a real
  // background `&` and a real `&&` must still end a subcommand, and the allow
  // lane must still refuse what follows one.
  it('still splits at a genuine `&` separator', () => {
    for (const separator of AMPERSAND_SEPARATORS) {
      expect(allowsBash(`${NPM_TEST}${separator}${RM_RF_ROOT}`, NPM_STAR)).toBe(false);
      expect(allowsBash(`${NPM_TEST}${separator}${NPM_RUN_LINT}`, NPM_STAR)).toBe(true);
    }
  });

  // A redirection must not make a LATER separator invisible — the failure mode
  // of every "just skip past it" fix in this file.
  it('keeps a separator that follows a redirection', () => {
    for (const redirection of AMPERSAND_REDIRECTIONS) {
      expect(allowsBash(`${LS_LA} ${redirection}; ${RM_RF_ROOT}`, LS_PREFIX)).toBe(false);
      expect(allowsBash(`${LS_LA} ${redirection} && ${RM_RF_ROOT}`, LS_PREFIX)).toBe(false);
      expect(matchesBashRule(`${LS_LA} ${redirection} && ${RM_RF_ROOT}`, RM_STAR, 'deny')).toBe(
        true,
      );
    }
  });

  // The deny lane reads the same separators, so a background `&` must not hide
  // the denied program from it, and a redirection must not manufacture one.
  it('the deny lane still reaches past a background `&`', () => {
    expect(matchesBashRule(`${NPM_TEST} & ${RM_RF_ROOT}`, RM_STAR, 'deny')).toBe(true);
    expect(matchesBashRule(`${NPM_TEST} 2>&1`, RM_STAR, 'deny')).toBe(false);
  });
});

describe('matchesPathRule — an empty tool input', () => {
  // 🚩 A live CRASH, not a wrong answer. `settings-compat-checker` asks the deny
  // lane about a BARE tool spelling by handing it an empty tool input, and
  // node-ignore throws `path must not be empty` on the relative path that
  // produces. `vat audit` on a plugin whose SKILL.md declares a bare `Read` or
  // `Edit` against an org `Read(…)`/`Edit(…)` deny rule terminated with an
  // uncaught TypeError rather than reporting anything.
  //
  // An empty path is not a path, so the only answer it can have is `false`: a
  // rule cannot match a file that was never named.
  it('answers false rather than throwing', () => {
    expect(() => matchesPathRule('', SECRETS_PATTERN, PLUGIN_DIR)).not.toThrow();
    expect(matchesPathRule('', SECRETS_PATTERN, PLUGIN_DIR)).toBe(false);
    for (const lane of LANES) {
      expect(matchesPermissionRule('Read', '', `Read(${SECRETS_PATTERN})`, lane, PLUGIN_DIR)).toBe(
        false,
      );
      expect(matchesPermissionRule('Edit', '', `Edit(${SECRETS_PATTERN})`, lane, PLUGIN_DIR)).toBe(
        false,
      );
    }
  });

  // The control: the same rule and root still match a real path, so the guard
  // is not a blanket `false` for the whole path lane.
  it('still matches a real path under the same root', () => {
    expect(matchesPathRule(SECRETS_KEY, SECRETS_PATTERN, PLUGIN_DIR)).toBe(true);
  });
});
