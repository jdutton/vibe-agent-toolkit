import { describe, expect, it } from 'vitest';

import { lint as lintWith, ruleConfig } from '../linter-harness.js';
import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const RULE = 'prefer-startswith-over-regex';

const CASES: RuleCases = {
  valid: [
    // unicorn would catch these, but our rule treats them as redundant — both are fine.
    { code: "const s = 'x'; if (s.startsWith('file://')) {}" },
    // Patterns with regex metacharacters — must NOT flag (cannot safely flatten).
    { code: String.raw`const s = 'x'; if (/^https?:\/\//.test(s)) {}` },
    { code: "const s = 'x'; if (/^[a-z]+/.test(s)) {}" },
    // Unescaped `.` is "any character" — flattening it would change what matches.
    { code: "const s = 'x'; if (/.txt$/.test(s)) {}" },
    { code: "const s = 'x'; if (/^foo|bar/.test(s)) {}" },
    // Flags i/m make literal conversion unsafe — must not flag.
    { code: "const s = 'x'; if (/^foo/i.test(s)) {}" },
    // Escapes that MEAN something other than the next character — a class, an
    // assertion, a code point — stay unflattenable.
    { code: String.raw`const s = 'x'; if (/^\d+/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\w/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\bword/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\cA/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\x41/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\p{Lu}/u.test(s)) {}` },
    // A control character would go straight into the suggested startsWith('…').
    { code: String.raw`const s = 'x'; if (/^\tab/.test(s)) {}` },
    // No anchor — not a prefix/suffix check.
    { code: "const s = 'x'; if (/foo/.test(s)) {}" },
    // An escaped `$` at the end is a LITERAL dollar sign, not an anchor —
    // there is no end-of-string check to flatten, so this must not flag.
    { code: String.raw`const s = 'x'; if (/price\$/.test(s)) {}` },
    // Method calls that aren't .test() — must not flag.
    { code: "const s = 'x'; const m = /^foo/.exec(s);" },
    // A const that does not hold a regex literal, and one reassigned after
    // declaration: nothing here proves what `.test()` runs against.
    { code: "const RE = makeRegex(); const s = 'x'; if (RE.test(s)) {}" },
    { code: "let RE = /^a/; RE = /^[b]/; const s = 'x'; if (RE.test(s)) {}" },
    { code: "const s = 'x'; if (someObject.pattern.test(s)) {}" },
    // Resolution must respect the same metachar/flag limits as the inline form.
    { code: String.raw`const RE = /^https?:\/\//; const s = 'x'; if (RE.test(s)) {}` },
    { code: "const RE = /^foo/i; const s = 'x'; if (RE.test(s)) {}" },
  ],
  invalid: [
    { code: String.raw`const s = 'x'; if (/^file:\/\//.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^ssh:\/\//.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const s = 'x'; if (/^foo/.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const s = 'x'; if (/bar$/.test(s)) {}", errors: [{ messageId: 'preferEndsWith' }] },
    // BACKSLASH-PARITY at the trailing anchor. `/\\$/`'s pattern is the
    // 3-char string `\\$` — an escaped backslash (`\\`) followed by an
    // UNESCAPED `$` anchor. Looking only at the literal last two characters
    // (`\$`) misreads this as an escaped dollar and skips it; the fix counts
    // the run of backslashes immediately before `$` and checks its parity.
    { code: String.raw`const s = 'x'; if (/\\$/.test(s)) {}`, errors: [{ messageId: 'preferEndsWith' }] },
    { code: "const s = 'x'; if (/^abc-def/.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    // ESCAPED NON-SPECIAL CHARACTER. `\*` is an unambiguous literal asterisk,
    // and accepting only `\/` skipped it — an adopter's SonarCloud raised the
    // MAJOR S6557 this rule exists to shift left, on code the rule reported
    // green. Every escape below denotes exactly the character it protects.
    { code: String.raw`const s = 'x'; if (/^\*glob/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^\.hidden/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    // Was pinned as VALID with the note "contains `.` metachar". It does not —
    // the `.` is escaped, and `/\.txt$/.test(s)` is `s.endsWith('.txt')` exactly.
    { code: String.raw`const s = 'x'; if (/\.txt$/.test(s)) {}`, errors: [{ messageId: 'preferEndsWith' }] },
    { code: String.raw`const s = 'x'; if (/^\$ref/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^\(paren/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/\+plus$/.test(s)) {}`, errors: [{ messageId: 'preferEndsWith' }] },
    // REGEX HELD IN A CONST — the normal way to hoist a hot regex, and the
    // shape the rule was blind to because it examined only inline literals.
    { code: "const RE = /^literal/; const s = 'x'; if (RE.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const RE = /suffix$/; const s = 'x'; if (RE.test(s)) {}", errors: [{ messageId: 'preferEndsWith' }] },
    {
      code: String.raw`const RE = /^file:\/\//; function f(s) { return RE.test(s); }`,
      errors: [{ messageId: 'preferStartsWith' }],
    },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(RULE, CASES); });
});

/**
 * `prefer-startswith-over-regex` emits SOURCE, so its message IS the deliverable.
 *
 * The rule has no fixer: nothing downstream re-escapes what it prints, and a
 * developer applies the advice by hand. So the literal it names must (a) parse
 * as a JS string and (b) denote exactly the characters the regex matches.
 * Neither held, and no fixture covered either.
 */
const PREFIX_ADVICE = /startsWith\((.*)\)` over/;
const SUFFIX_ADVICE = /endsWith\((.*)\)` over/;

/** The literal the message tells a developer to write, decoded as JS would. */
function advisedLiteral(message: string | undefined): string {
  const text = message ?? '';
  const match = PREFIX_ADVICE.exec(text) ?? SUFFIX_ADVICE.exec(text);
  if (!match?.[1]) {
    throw new Error(`no advice found in: ${text}`);
  }
  // `JSON.parse` accepts exactly the escapes a JS string literal does for the
  // shapes this rule emits — and THROWS on the un-escaped text it used to
  // produce, which is the point.
  return JSON.parse(match[1]) as string;
}

describe('prefer-startswith-over-regex advice is valid, faithful JavaScript', () => {
  const config = ruleConfig(RULE);
  const lint = (code: string): string[] => lintWith(code, config).map(({ message }) => message);

  /**
   * `[source, the characters the regex actually matches]`.
   *
   * Every row turns on a backslash or a quote — the two things that mean one
   * thing to a regex and another to a JS string literal. `/^C:\\Users/` matches
   * `C:\Users`; the rule printed `startsWith('C:\Users')`, which JavaScript
   * reads back as `"C:Users"`. The UNC row is the one that bites in production:
   * `startsWith('\\')` is ONE backslash, so a `\\`-prefix check silently
   * becomes true for every single-backslash path.
   */
  const FAITHFUL_ADVICE: Array<[string, string]> = [
    [String.raw`/^C:\\Users/`, String.raw`C:\Users`],
    [String.raw`/^\\\\/`, '\\\\'],
    [String.raw`/^a\\nb/`, String.raw`a\nb`],
    [String.raw`/^a\\x41/`, String.raw`a\x41`],
    [String.raw`/\\nb$/`, String.raw`\nb`],
    ["/^don't/", "don't"],
    [String.raw`/^don\'t/`, "don't"],
    [String.raw`/^\*glob/`, '*glob'],
    [String.raw`/^file:\/\//`, 'file://'],
  ];

  it.each(FAITHFUL_ADVICE)('%s advises the exact characters it matches', (source, expected) => {
    const messages = lint(`export const f = (s) => ${source}.test(s);`);
    expect(messages).toHaveLength(1);
    // Parses as JS…
    const advised = advisedLiteral(messages[0]);
    // …and denotes the same characters the regex does.
    expect(advised).toBe(expected);
  });

  it.each(FAITHFUL_ADVICE)('%s advice agrees with the regex on real strings', (source, expected) => {
    // `source` is a fixture literal declared in FAITHFUL_ADVICE above; rebuilding it here is what
    // lets one row drive both the lint fixture and the semantics check, so the two cannot drift
    // apart. (The directive must sit on the line immediately before the call — a run of `//`
    // comments is a run of separate comments, so a directive above them targets only the next
    // comment line and is silently unused.)
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixture literal, never input
    const regex = new RegExp(source.slice(1, source.lastIndexOf('/')));
    const atStart = regex.source.startsWith('^');
    const probes = [expected, `${expected}TAIL`, `HEAD${expected}`, expected.slice(1), '', 'unrelated'];
    for (const probe of probes) {
      const viaAdvice = atStart ? probe.startsWith(expected) : probe.endsWith(expected);
      expect({ probe, matched: regex.test(probe) }).toStrictEqual({ probe, matched: viaAdvice });
    }
  });

  /**
   * `g`/`y` make `.test()` stateful through `lastIndex`. A regex LITERAL is
   * rebuilt on every evaluation so its cursor is always 0; a hoisted `const` is
   * one object that remembers. Resolving through a binding is therefore exactly
   * what makes the advice wrong — and exactly what this rule newly does.
   */
  it.each(['g', 'y', 'gy'])('stays silent on a const-held regex with the %s flag', (flags) => {
    expect(lint(`const RE = /^abc/${flags};\nexport const f = (s) => RE.test(s);`)).toStrictEqual([]);
  });

  it('demonstrates the divergence the g-flag guard prevents', () => {
    const held = /^abc/g;
    expect([1, 2, 3, 4].map(() => held.test('abcdef'))).toStrictEqual([true, false, true, false]);
    expect([1, 2, 3, 4].map(() => 'abcdef'.startsWith('abc'))).toStrictEqual([true, true, true, true]);
  });

  it('still fires on an INLINE regex with g — the literal is rebuilt, so lastIndex is always 0', () => {
    expect(lint('export const f = (s) => /^abc/g.test(s);')).toHaveLength(1);
    // The regex literal below is the SUBJECT, not a style slip. `--fix` rewrote
    // it to `'abcdef'.startsWith('abc')` — via this very rule and unicorn's —
    // which left the assertion comparing `startsWith` to `startsWith` and
    // passing vacuously. Exactly the class of defect this file exists to catch,
    // committed against the file itself.
    /* eslint-disable local/prefer-startswith-over-regex, unicorn/prefer-string-starts-ends-with -- the inline literal IS the assertion */
    expect([1, 2, 3, 4].map(() => /^abc/g.test('abcdef'))).toStrictEqual([true, true, true, true]);
    /* eslint-enable local/prefer-startswith-over-regex, unicorn/prefer-string-starts-ends-with */
  });

  it('renders the flags, so a reader can see what the advice rests on', () => {
    expect(lint('export const f = (s) => /^abc/s.test(s);')[0]).toContain('/^abc/s.test(');
  });

  it('needs exactly one argument', () => {
    expect(lint('export const f = () => /^abc/.test();')).toStrictEqual([]);
    expect(lint('export const f = (s) => /^abc/.test(s, 1);')).toStrictEqual([]);
  });

  /**
   * MEMBERSHIP of the bail class, pinned character by character.
   *
   * An adversarial run dropped 12 of the 22 characters and this suite stayed
   * green — only 7 were named by any fixture. Under that mutant `/^\sfoo/`
   * advised `startsWith('sfoo')`. Both directions are asserted here, so neither
   * a narrowing nor a widening can pass unremarked.
   */
  const MEANINGFUL = [...'0123456789BDPSWbcdfknprstuvwx'];
  const IDENTITY = [...'AaEeGgHhIiJjLlMmOoQqRrTtYyZz'].filter((char) => !MEANINGFUL.includes(char));

  it.each(MEANINGFUL)(String.raw`\%s means something other than the character, so it bails`, (char) => {
    expect(lint(`export const f = (s) => /^\\${char}tail/.test(s);`)).toStrictEqual([]);
  });

  it.each(IDENTITY)(String.raw`\%s is an identity escape, so it flattens`, (char) => {
    const messages = lint(`export const f = (s) => /^\\${char}tail/.test(s);`);
    expect(messages).toHaveLength(1);
    expect(advisedLiteral(messages[0])).toBe(`${char}tail`);
  });
});
