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

import { compilePathPattern, matchesPathPattern } from '../src/settings/path-pattern.js';

const matches = (pattern: string, path: string): boolean =>
  matchesPathPattern(compilePathPattern(pattern), path);

const oracle = (pattern: string, path: string): boolean => ignore().add(pattern).ignores(path);

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
    const disagreements: string[] = [];
    for (const pattern of PATTERNS) {
      for (const path of PATHS) {
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
});

describe('path patterns — the shapes the lane hands over', () => {
  it('treats a `/`-suffixed path as the same file path', () => {
    expect(matches('a/b', 'a/b/')).toBe(true);
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
