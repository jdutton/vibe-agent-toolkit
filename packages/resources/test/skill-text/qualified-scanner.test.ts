/**
 * The `mcp__<server>__<tool>` scanner against the regex it replaced.
 *
 * `OLD_CLAUDE_CODE_QUALIFIED` is the agent-skills regex verbatim. It is
 * quadratic on `"mcp__-".repeat(n)`, so it is the ORACLE here on short inputs
 * only. The scanner's linearity is proven by work this test counts itself,
 * never by time and never by the scanner's own `steps` alone: every
 * per-character decision the purity rule lets the scanner make goes through
 * the declaration's three character classes, which the test hands it as
 * counting wrappers, and every string method it calls goes through a counting
 * proxy, which also proves it calls none that scans (`indexOf` and kin), whose
 * cost one call would hide.
 */
import { seededRandom } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';
import { scanClaudeCodeQualified } from '../../src/skill-text/qualified-scanner.js';

const OLD_CLAUDE_CODE_QUALIFIED = /\bmcp__[\w-]+?__([a-z][A-Za-z0-9_-]*)(?![\w-])/gu;

/** The work an instrumented scan did, counted outside the scanner. */
interface CountedWork {
  /** Calls to the declaration's character classes. */
  classTests: number;
  /** String methods the scan called, by name. */
  readonly methods: Map<string, number>;
}

/**
 * String methods whose one call scans a run of the text: none may appear, or a call count hides
 * their cost. The one exception is the scanner's single prefix `includes`, which its `steps`
 * counts as a full pass and the counted test allows exactly once.
 */
const SCANNING_METHODS = ['indexOf', 'lastIndexOf', 'includes', 'search', 'match', 'matchAll', 'split', 'replace', 'replaceAll', 'endsWith'];

/**
 * Scan `text` with every character class and string method counted.
 *
 * @param text - The text
 * @returns The captures and the counted work
 */
function countedScan(text: string): { captures: string[]; work: CountedWork } {
  const work: CountedWork = { classTests: 0, methods: new Map() };
  const counting = (pattern: RegExp): RegExp => ({
    test: (value: string) => {
      work.classTests++;
      return pattern.test(value);
    },
  }) as unknown as RegExp;
  const { mcp } = SKILL_TEXT_DECLARATION;
  const declaration = {
    ...SKILL_TEXT_DECLARATION,
    mcp: { ...mcp, wordChar: counting(mcp.wordChar), nameChar: counting(mcp.nameChar), toolStart: counting(mcp.toolStart) },
  };
  const target = Object(text) as object;
  const proxied = new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof key !== 'string' || typeof value !== 'function') return value;
      work.methods.set(key, (work.methods.get(key) ?? 0) + 1);
      return (...args: unknown[]) => (value as (...parameters: unknown[]) => unknown).apply(text, args);
    },
  });
  const { captures } = scanClaudeCodeQualified(proxied as unknown as string, declaration);
  return { captures, work };
}

function oldCaptures(text: string): string[] {
  return [...text.matchAll(OLD_CLAUDE_CODE_QUALIFIED)].map((match) => match[1] ?? '');
}

function scanned(text: string): string[] {
  return scanClaudeCodeQualified(text, SKILL_TEXT_DECLARATION).captures;
}

const HAND_CORPUS = [
  '',
  'mcp__',
  'mcp__x__get_me',
  'use mcp__plugin_github_github__get_me now',
  'mcp__zapier__gmail__send_email',
  'mcp__linear__createIssue',
  'mcp__x__get_userInfo',
  'mcp__plugin_microsoft-docs_microsoft-learn__microsoft_docs_search',
  'mcp__claude-in-chrome__browser_batch',
  'mcp__plugin_context7_context7__resolve-library-id',
  '`mcp__x__do_thing_`',
  'mcp__x__foo-Bar',
  'xmcp__a__bc',
  'x-mcp__a__bc',
  '_mcp__a__bc',
  '0mcp__a__bc',
  'mcp__-mcp__x__ab',
  'mcp__x___a',
  'mcp__x__Abc',
  'mcp__x__1abc',
  'mcp____ab',
  'mcp___ab',
  'mcp__a__',
  'mcp__a__b mcp__c__d',
  'mcp__a__b-mcp__c__d',
  'mcp__a__b.mcp__c__d',
  'mcp__a b__c',
  'émcp__a__bc',
  '😀mcp__a__bc',
  'mcp__a__bc😀',
  'mcp__a__b\nmcp__c__d',
  'MCP__a__bc',
  'mcp__-'.repeat(40),
  `${'mcp__-'.repeat(40)}__a`,
];

const ALPHABET = ['m', 'c', 'p', '_', '-', 'a', 'Z', '0', ' '];
/** The alphabet plus the two tokens a match needs, so hits are common rather than rare. */
const TOKENS = [...ALPHABET, 'mcp__', '__'];

function generated(random: () => number, symbols: readonly string[], maxSymbols: number): string {
  const count = Math.floor(random() * maxSymbols);
  let text = '';
  for (let index = 0; index < count; index++) text += symbols[Math.floor(random() * symbols.length)] ?? '';
  return text;
}

describe('scanClaudeCodeQualified', () => {
  it.each(HAND_CORPUS.map((text) => [JSON.stringify(text), text]))('equals the old regex on %s', (_label, text) => {
    expect(scanned(text)).toEqual(oldCaptures(text));
  });

  it('finds the hand corpus non-vacuously', () => {
    expect(scanned('use mcp__plugin_github_github__get_me now')).toEqual(['get_me']);
    expect(scanned('mcp__zapier__gmail__send_email')).toEqual(['gmail__send_email']);
    expect(scanned('mcp__linear__createIssue')).toEqual(['createIssue']);
  });

  it('equals the old regex on generated strings over the alphabet', () => {
    const random = seededRandom(20_261_121);
    let hits = 0;
    for (let round = 0; round < 4000; round++) {
      const text = generated(random, round % 2 === 0 ? ALPHABET : TOKENS, 48);
      const expected = oldCaptures(text);
      hits += expected.length;
      expect(scanned(text), JSON.stringify(text)).toEqual(expected);
    }
    // The property is not vacuous: the generator reaches matches.
    expect(hits).toBeGreaterThan(200);
  });

  it('does no per-character work on a text without the prefix, and finds nothing there', () => {
    const text = 'mcp_ x__get_me `mcp_-_a__b` MCP__a__b '.repeat(500);
    expect(oldCaptures(text)).toEqual([]);
    const { captures, work } = countedScan(text);
    expect(captures).toEqual([]);
    expect(work.classTests).toBe(0);
    expect([...work.methods.entries()]).toEqual([['includes', 1]]);
    expect(scanClaudeCodeQualified(text, SKILL_TEXT_DECLARATION).steps).toBe(text.length);
  });

  // One pass for the prefix check, two right-to-left passes and the left-to-right walk.
  it.each([1000, 10_000, 100_000, 1_000_000])('takes at most 4 steps per character on n=%i', (size) => {
    const adversarial = 'mcp__-'.repeat(Math.ceil(size / 6)).slice(0, size);
    const mixed = `${'mcp__a__b '.repeat(Math.ceil(size / 10))}`.slice(0, size);
    for (const text of [adversarial, mixed]) {
      const { steps } = scanClaudeCodeQualified(text, SKILL_TEXT_DECLARATION);
      expect(steps).toBeLessThanOrEqual(4 * text.length);
    }
  });

  it.each([1000, 10_000, 50_000])('does linear work by its own count, which the scanner does not keep, on n=%i', (size) => {
    const adversarial = 'mcp__-'.repeat(Math.ceil(size / 6)).slice(0, size);
    const mixed = `${'mcp__a__b '.repeat(Math.ceil(size / 10))}`.slice(0, size);
    for (const text of [adversarial, mixed]) {
      const { captures, work } = countedScan(text);
      expect(captures).toEqual(scanClaudeCodeQualified(text, SKILL_TEXT_DECLARATION).captures);
      // One class test per position for the name runs, at most one per position for the tool
      // separators and one per prefix start: three per character.
      expect(work.classTests).toBeLessThanOrEqual(3 * text.length);
      // Not vacuous: the wrappers and the proxy saw the scan's every position.
      expect(work.classTests).toBeGreaterThanOrEqual(text.length);
      expect(work.methods.get('charAt') ?? 0).toBeGreaterThanOrEqual(text.length);
      const calls = [...work.methods.values()].reduce((sum, count) => sum + count, 0);
      // charAt per class test, startsWith per position in two places, a slice per capture.
      expect(calls).toBeLessThanOrEqual(6 * text.length);
      expect(work.methods.get('includes')).toBe(1);
      expect(SCANNING_METHODS.filter((name) => name !== 'includes' && work.methods.has(name))).toEqual([]);
    }
  });

  it('counts steps in proportion to length', () => {
    const small = scanClaudeCodeQualified('mcp__-'.repeat(1000), SKILL_TEXT_DECLARATION).steps;
    const large = scanClaudeCodeQualified('mcp__-'.repeat(10_000), SKILL_TEXT_DECLARATION).steps;
    expect(large).toBeLessThanOrEqual(11 * small);
  });
});
