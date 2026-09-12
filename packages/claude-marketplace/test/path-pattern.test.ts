/**
 * Unit tests for the linear gitignore-style path matcher.
 *
 * 🔑 The semantics under test are node-ignore's, which is what the path lane
 * asked of node-ignore before it was replaced for its backtracking cost. So the
 * oracle IS node-ignore: every (pattern, path) pair below is answered by both,
 * and the two must agree — a hand-written truth table would only pin what the
 * author remembered of the gitignore spec. The pairs are kept star-poor so the
 * oracle itself answers in microseconds; the cost claim is pinned separately
 * against the matcher alone.
 */

import ignore from 'ignore';
import { describe, expect, it } from 'vitest';

import { compilePathPattern, matchesPathPattern, witnessOf } from '../src/settings/path-pattern.js';

const matches = (pattern: string, path: string): boolean =>
  matchesPathPattern(compilePathPattern(pattern), path);

const oracle = (pattern: string, path: string): boolean => ignore().add(pattern).ignores(path);

/**
 * On Windows node-ignore rewrites every `\` in the PATH to `/` before matching
 * (its `makePosix`, also switched on by `IGNORE_TEST_WIN32`), so there it answers
 * a different question for a path holding a backslash. That rewrite is input
 * normalisation, not pattern semantics — and the production caller performs it
 * upstream of this seam: `matchesPathRule` hands over `safePath.relative()`
 * output, forward slashes on every platform. A literal `\` can therefore reach
 * the matcher only on POSIX, where it is a filename character, and the oracle
 * agrees. The pair is asked only where both sides read the same input; the
 * matcher's own reading is pinned platform-independently below.
 */
const ORACLE_READS_BACKSLASH_AS_SEPARATOR =
  process.platform === 'win32' || Boolean(process.env['IGNORE_TEST_WIN32']);

/** The spellings the permissions documentation and this repo's own settings use. */
const PATTERNS = [
  'secrets',
  'secrets/',
  '/secrets',
  'secrets/**',
  'secrets/**/',
  '*.env',
  '.env*',
  'a/*.env',
  '**/.env',
  '**/.env*',
  '**/a',
  'a/**/b',
  'a/**',
  'a/b/**',
  '**/a/**',
  '**',
  '**/**',
  '*',
  '*/',
  'a**b',
  'a**',
  'a/**b',
  'a?c',
  'a[bc]d',
  'a[a-c]d',
  'SECRETS',
  String.raw`a\*b`,
  String.raw`a\ b`,
  String.raw`a\[b]`,
  String.raw`a\\b`,
  String.raw`\#a`,
  '#a',
  '!a',
  'a b',
  '.ssh/**',
  '.ssh/id_rsa',
  'src/**/*.ts',
  'a*a*b',
  'a-b/c_d.e',
  // A bare `**` with a trailing `/` is directory-only: it names no directory
  // for the `/` to restrict, so the `**` itself must span one.
  '**/',
  '/**/',
  '**/**/',
  // Empty and slash-only patterns, and an empty segment: nothing is named, so
  // nothing is matched.
  '',
  '/',
  '//',
  '///',
  '//a',
  'a//b',
  'a//',
];

/** Paths chosen to land on both sides of every pattern above. */
const PATHS = [
  'secrets',
  'secrets/key',
  'a/secrets/key',
  'x.env',
  'a/b/x.env',
  'a/x.env/y',
  'a/x.env',
  '.env',
  'x/.env',
  'x/.env.local',
  'x/.envdir/y',
  'a',
  'x/y/a',
  'a/b',
  'a/x/y/b',
  'a/b/c',
  'x/a/y',
  'a/y',
  'x/a',
  'anything/here',
  'axxb',
  'ax/xb',
  'ax/y',
  'a/xb',
  'abc',
  'a/c',
  'acd',
  'abd',
  'aad',
  'a*b',
  'axb',
  'a b',
  'a[b]',
  String.raw`a\b`,
  '#a',
  '.ssh/**',
  '.ssh/id_rsa',
  'src/x.ts',
  'src/a/b/x.ts',
  'aaab',
  'SECRETS/KEY',
  'a-b/c_d.e',
  'a-b/c_d.e/f',
];

describe('path patterns — the node-ignore oracle', () => {
  it('agrees with node-ignore on every (pattern, path) pair', () => {
    const paths = ORACLE_READS_BACKSLASH_AS_SEPARATOR
      ? PATHS.filter((path) => !path.includes('\\'))
      : PATHS;
    // The filter must not quietly empty the table, or drop more than the one row it names.
    expect(PATHS.length - paths.length).toBeLessThanOrEqual(1);
    const disagreements: string[] = [];
    for (const pattern of PATTERNS) {
      for (const path of paths) {
        if (matches(pattern, path) !== oracle(pattern, path)) {
          disagreements.push(`${JSON.stringify(pattern)} vs ${JSON.stringify(path)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  // The oracle table cannot be all one answer, or a constant matcher passes it.
  it('is asked a question with both answers in it', () => {
    const answers = new Set(PATTERNS.flatMap((pattern) => PATHS.map((path) => oracle(pattern, path))));
    expect(answers).toEqual(new Set([true, false]));
  });
});

describe('path patterns — the documented divergences from the oracle', () => {
  // node-ignore's compiled regex fails on these and it answers `false`; a
  // literal reading is the more useful answer in a lane where `false` means
  // "no conflict".
  it('reads an unterminated `[` as a literal', () => {
    expect(matches('a[', 'a[')).toBe(true);
    expect(matches('a[', 'ab')).toBe(false);
    expect(matches('[', '[')).toBe(true);
    expect(oracle('[', '[')).toBe(false);
  });

  it('reads `[]` and `[!]` as the literal characters', () => {
    expect(matches('a[]b', 'a[]b')).toBe(true);
    expect(matches('a[!]b', 'a[!]b')).toBe(true);
    expect(matches('a[!]b', 'axb')).toBe(false);
    // node-ignore: `[!]` is a single-member class holding `!`.
    expect(oracle('a[!]b', 'a!b')).toBe(true);
    expect(oracle('a[!]b', 'a[!]b')).toBe(false);
  });

  // ⚖️ node-ignore@6 reads `[!bc]` as the literal set `{!, b, c}`; the gitignore
  // spec the permissions page names negates the class, and so does this. The
  // oracle's answer is pinned alongside so the divergence is a recorded one.
  it('negates a `[!…]` / `[^…]` class, where node-ignore does not', () => {
    for (const pattern of ['a[!bc]d', 'a[^bc]d']) {
      expect(matches(pattern, 'acd')).toBe(false);
      expect(matches(pattern, 'aad')).toBe(true);
      expect(oracle(pattern, 'acd')).toBe(true);
      expect(oracle(pattern, 'aad')).toBe(false);
    }
  });

  // node-ignore compiles a trailing `\*` back into a wildcard; the spec says an
  // escaped `*` is the character.
  it('reads a trailing `\\*` as the literal character', () => {
    expect(matches(String.raw`a\*`, 'a*')).toBe(true);
    expect(matches(String.raw`a\*`, 'ab')).toBe(false);
    expect(matches(String.raw`\*`, 'x')).toBe(false);
    expect(oracle(String.raw`a\*`, 'ab')).toBe(true);
    expect(oracle(String.raw`\*`, 'x')).toBe(true);
  });

  // node-ignore compiles `\?` to `\[^/]`, which matches nothing useful.
  it('reads `\\?` as the literal character', () => {
    expect(matches(String.raw`a\?`, 'a?')).toBe(true);
    expect(matches(String.raw`a\?`, 'ab')).toBe(false);
    expect(oracle(String.raw`a\?`, 'a?')).toBe(false);
  });

  // node-ignore passes `\b`, `\d`, `\s` and `\w` through to its regex, where they
  // are a word boundary and three character classes — the same accident the Bash
  // lane's docstring records. An escape is the character it escapes, so `\d`
  // is `d` and never `5`. (`\w` is the one that agrees on its own letter, `w`
  // being a word character.)
  it('reads `\\b` / `\\d` / `\\s` / `\\w` as the escaped letters', () => {
    expect(matches(String.raw`\b`, 'b')).toBe(true);
    expect(oracle(String.raw`\b`, 'b')).toBe(false);
    expect(matches(String.raw`\d`, 'd')).toBe(true);
    expect(matches(String.raw`\d`, '5')).toBe(false);
    expect(oracle(String.raw`\d`, 'd')).toBe(false);
    expect(oracle(String.raw`\d`, '5')).toBe(true);
    expect(matches(String.raw`\s`, 's')).toBe(true);
    expect(matches(String.raw`\s`, ' ')).toBe(false);
    expect(oracle(String.raw`\s`, ' ')).toBe(true);
    expect(matches(String.raw`\w`, 'x')).toBe(false);
    expect(oracle(String.raw`\w`, 'x')).toBe(true);
  });

  // A `\` with nothing after it escapes nothing, so it is itself. (The oracle
  // side is a path holding a backslash, which node-ignore rewrites on Windows.)
  it('reads a `\\` at the end of the pattern as the literal character', () => {
    // (A `\` before a closing backtick escapes it even under `String.raw`.)
    const trailingBackslash = 'a\\';
    expect(matches(trailingBackslash, trailingBackslash)).toBe(true);
    expect(matches(trailingBackslash, 'a')).toBe(false);
    if (!ORACLE_READS_BACKSLASH_AS_SEPARATOR) expect(oracle(trailingBackslash, trailingBackslash)).toBe(false);
  });

  // A `/` is the segment separator before it is anything else, so `a[/]b` is
  // the two segments `a[` and `]b`, and a class never matches a separator, as
  // the spec requires; node-ignore lets `[/]` match one.
  it('splits the segment at a `/` inside a class', () => {
    expect(matches('a[/]b', 'a/b')).toBe(false);
    expect(matches('a[/]b', 'a[/]b')).toBe(true);
    expect(oracle('a[/]b', 'a/b')).toBe(true);
    expect(oracle('a[/]b', 'a[/]b')).toBe(false);
  });

  // POSIX: a `]` first in a class is a member, and `[\]]` is the class holding
  // `]`. node-ignore closes the class at the first `]` it sees.
  it('reads a leading or escaped `]` as a class member', () => {
    expect(matches('[]a]', ']')).toBe(true);
    expect(matches('[]a]', 'a')).toBe(true);
    expect(matches('[]a]', 'b')).toBe(false);
    expect(matches(String.raw`[\]]`, ']')).toBe(true);
    expect(oracle('[]a]', ']')).toBe(false);
    expect(oracle('[]a]', 'a')).toBe(false);
    expect(oracle(String.raw`[\]]`, ']')).toBe(false);
  });

  // ⚖️ Not aligned, and not worth aligning: `toLowerCase()` and a regex `i`
  // flag fold case differently at the edges of Unicode, and each side's answer
  // is an accident of its mechanism rather than a reading of the spec.
  it('folds Unicode case by `toLowerCase()`, where node-ignore folds by regex `i`', () => {
    expect(matches('ẞ', 'ß')).toBe(true);
    expect(oracle('ẞ', 'ß')).toBe(false);
    expect(matches('İ', 'i̇')).toBe(true);
    expect(oracle('İ', 'i̇')).toBe(false);
    expect(matches('Σ', 'ς')).toBe(false);
    expect(oracle('Σ', 'ς')).toBe(true);
  });
});

describe('path patterns — a directory-only bare `**`', () => {
  // 🚩 `directoryOnly` was dropped whenever the last raw segment was `**`, which
  // is right for `a/**/` (everything inside `a`, exactly as `a/**` is) and wrong
  // when the pattern is ONLY `**`: there is no named directory for the `/` to
  // restrict, so the `**` itself must span one, and a top-level FILE is under
  // no directory. node-ignore agrees; pinned in the oracle table too.
  it('requires a directory above the file', () => {
    for (const pattern of ['**/', '/**/', '**/**/']) {
      expect(matches(pattern, 'a'), pattern).toBe(false);
      expect(matches(pattern, 'a/b'), pattern).toBe(true);
      expect(matches(pattern, 'a/b/c'), pattern).toBe(true);
    }
  });

  it('still reads `a/**/` as `a/**`', () => {
    for (const path of ['a', 'a/b', 'a/b/c', 'x/a/b']) {
      expect(matches('a/**/', path), path).toBe(matches('a/**', path));
    }
    expect(matches('a/**', 'a/b')).toBe(true);
  });
});

describe('path patterns — nothing to match', () => {
  // 🚩 An empty body compiled to a lone leading globstar, and the ancestor rule
  // appended another, so `''`, `/` and `//` matched EVERYTHING — reachable as
  // `Read()`, `Read(/)`, `Read(~/)`, `Read(./)` through the permission lane's
  // prefix table. node-ignore matches nothing with them, and so does this: a
  // pattern that names no segment names no file. An empty segment in the
  // middle (`a//b`) is the same thing one level down — no normalised path has
  // one, and node-ignore never matches it either.
  it('matches nothing with an empty or slash-only pattern, or an empty segment', () => {
    for (const pattern of ['', '/', '//', '///', '//*', '//a', 'a//b', 'a//']) {
      expect(compilePathPattern(pattern).matchesNothing, JSON.stringify(pattern)).toBe(true);
      expect(matches(pattern, 'a'), JSON.stringify(pattern)).toBe(false);
      expect(matches(pattern, 'a/b'), JSON.stringify(pattern)).toBe(false);
    }
  });

  // The controls: one leading slash anchors, one trailing slash restricts to
  // directories, and neither empties the pattern.
  it('still reads a single leading or trailing `/`', () => {
    expect(matches('/a', 'a')).toBe(true);
    expect(matches('/a', 'x/a')).toBe(false);
    expect(matches('a/', 'a/b')).toBe(true);
    expect(matches('a/', 'a')).toBe(false);
    expect(matches('/*', 'x')).toBe(true);
  });
});

describe('witnessOf — one member of the pattern, materialised', () => {
  // 🚩 The permission lane used to read a rule's RAW text as a literal file
  // path and call it a witness of the rule. That works for `*`, `**` and `?`
  // only because `*` and `?` match themselves as characters, so a rule holding
  // `[…]` or `\` was not a member of its own extension and an identical
  // `Read(a[!b]c)` pair reported no conflict. The witness is built from the
  // compiled tokens instead, and the property is the whole contract: a pattern
  // matches its own witness.
  it('is matched by the pattern it was drawn from', () => {
    const live = PATTERNS.filter((pattern) => !compilePathPattern(pattern).matchesNothing);
    const misses = live.filter((pattern) => !matches(pattern, witnessOf(compilePathPattern(pattern))));
    expect(misses).toEqual([]);
    // …and the property was asked of a class, an escape, a `?`, a `**` and a
    // directory-only pattern, not of a table of literals.
    expect(live).toEqual(expect.arrayContaining(['a[bc]d', String.raw`a\*b`, 'a?c', 'secrets/', '**/.env', 'a/**']));
  });

  it('picks a member of a class, in and out of a negation', () => {
    expect(witnessOf(compilePathPattern('a[bc]d'))).toBe('abd');
    expect(witnessOf(compilePathPattern('a[!b]c'))).toBe('axc');
    expect(witnessOf(compilePathPattern('a[!x]c'))).toBe('aac');
    expect(witnessOf(compilePathPattern('**/x[0-9].env'))).toBe('x0.env');
  });

  it('spans zero directories for `**`, one character for `?`, none for `*`, and a file under a directory', () => {
    expect(witnessOf(compilePathPattern('**/.env'))).toBe('.env');
    expect(witnessOf(compilePathPattern('a?c'))).toBe('axc');
    expect(witnessOf(compilePathPattern('a*c'))).toBe('ac');
    expect(witnessOf(compilePathPattern(String.raw`a\*c`))).toBe('a*c');
    expect(witnessOf(compilePathPattern('*'))).toBe('x');
    expect(witnessOf(compilePathPattern('**'))).toBe('x');
    expect(witnessOf(compilePathPattern('a/*/b'))).toBe('a/x/b');
    expect(witnessOf(compilePathPattern('secrets/'))).toBe('secrets/x');
    expect(witnessOf(compilePathPattern('.ssh/**'))).toBe('.ssh/x');
    expect(witnessOf(compilePathPattern('**/'))).toBe('x/x');
  });

  it('is empty for a pattern that matches nothing', () => {
    for (const pattern of ['#a', '!a', '', '/']) {
      expect(witnessOf(compilePathPattern(pattern)), JSON.stringify(pattern)).toBe('');
    }
  });
});

describe('path patterns — the shapes the lane hands over', () => {
  it('treats a `/`-suffixed path as the same file path', () => {
    expect(matches('a/b', 'a/b/')).toBe(true);
  });

  // The lane hands over `safePath.relative()` output — `/`-separated on every
  // platform — so a backslash that does arrive is a filename character, never a
  // separator. Pinned on every platform, unlike the oracle table above.
  it('reads a backslash in the path as a literal character on every platform', () => {
    expect(matches(String.raw`a\\b`, String.raw`a\b`)).toBe(true);
    expect(matches('a/b', String.raw`a\b`)).toBe(false);
    expect(matches('**/a', String.raw`a\b`)).toBe(false);
    expect(matches('a**b', String.raw`a\b`)).toBe(true);
  });

  it('answers false for an empty path', () => {
    expect(matches('**', '')).toBe(false);
  });

  it('reads a class range through an escape and a trailing dash literally', () => {
    expect(matches(String.raw`a[\]x]b`, 'a]b')).toBe(true);
    expect(matches('a[x-]b', 'a-b')).toBe(true);
    expect(matches('a[x-]b', 'axb')).toBe(true);
    expect(matches('a[x-]b', 'ayb')).toBe(false);
  });
});
