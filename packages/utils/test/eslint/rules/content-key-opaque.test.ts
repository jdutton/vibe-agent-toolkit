/**
 * `content-key-opaque` — a `ContentKey` is opaque outside its one parser: no cast mints one, no
 * string method reads into one, no `compareCodeUnits`/`localeCompare` orders one, no `===`/`!==`
 * compares two. The brand is found through the type checker, so the VALID cases pin the decoys a
 * name match would get wrong (a type NAMED `ContentKey` with another brand, a plain string, an array
 * of keys) and the INVALID ones pin the brand reached under another name, through a union, a
 * parameter and a type parameter. The `allowFiles` legs pin the exemption: anchored at a path
 * segment, so a same-named file elsewhere is still linted.
 */

import { describe, expect, it } from 'vitest';

import { loadLocalRule, RULE_TESTER_CASES, type RuleCases, ruleTester } from '../rule-tester.js';
import { expectTypedRulePasses, typedCaseFile } from '../typed-rule-tester.js';

const RULE = 'content-key-opaque';
const FILE = typedCaseFile('packages/cli/src/consumer.ts');
const PARSER_FILE = 'packages/resources/src/content-key.ts';
const ALLOW = [{ allowFiles: [PARSER_FILE] }];

/** The brand as `resources` declares it, a second key, a plain string and the repo's comparator. */
const PRELUDE = [
  "type ContentKey = string & { readonly __brand: 'ContentKey' };",
  'declare const key: ContentKey;',
  'declare const other: ContentKey;',
  'declare const maybe: ContentKey | undefined;',
  'declare const keys: readonly ContentKey[];',
  'declare const text: string;',
  'declare function compareCodeUnits(a: string, b: string): number;',
  'declare function equalContentKeys(a: ContentKey, b: ContentKey): boolean;',
  'export {};',
  '',
].join('\n');

const at = (code: string, filename = FILE): { code: string; filename: string } => ({ code: PRELUDE + code, filename });
const flagged = (code: string, messageId: string, filename = FILE): RuleCases['invalid'][number] => ({
  ...at(code, filename),
  errors: [{ messageId }],
});

const CASES: RuleCases = {
  valid: [
    // The contract's own surface.
    at('const same = equalContentKeys(key, other);'),
    // An assertion from a value already keyed mints nothing: narrowing away `undefined`.
    at('const first = keys[0] as ContentKey; const sure = maybe as ContentKey; const same = key as ContentKey;'),
    // Ordering by bare sort or `<`/`>` is harmless: key order equals text order.
    at('const sorted = [...keys].sort(); const less = key < other;'),
    // A string method on a plain string, and on an array OF keys (Array#includes, Array#at).
    at("const cut = text.slice(0, 4); const has = text.includes(':');"),
    at('const has = keys.includes(key); const first = keys.at(0);'),
    // A key handed to a function that takes a string is not a read of its text.
    at('const length = String(key).length;'),
    // A key compared with a plain string is not two keys compared.
    at('const same = key === text;'),
    at('const order = compareCodeUnits(text, text);'),
    // Decoy: a type NAMED ContentKey whose brand is another string.
    at("type Fake = string & { readonly __brand: 'Other' }; declare const fake: Fake; const cut = fake.slice(0, 4); const minted = text as Fake;"),
    // Decoy: `__brand` holding a non-literal string.
    at('type Loose = string & { readonly __brand: string }; declare const loose: Loose; const cut = loose.slice(0, 4);'),
    // The parser itself, allowed by its full repo-relative path.
    { ...at('const minted = text as ContentKey; const cut = key.slice(0, 4);', typedCaseFile(PARSER_FILE)), options: ALLOW },
  ],
  invalid: [
    // A cast mints a key without the parser.
    flagged('const minted = text as ContentKey;', 'assertion'),
    flagged('const minted = <ContentKey>text;', 'assertion'),
    flagged('const minted = text as unknown as ContentKey;', 'assertion'),
    flagged('const minted = text as ContentKey | undefined;', 'assertion'),
    // The brand under another name is still the brand.
    flagged('type Key = ContentKey; const minted = text as Key;', 'assertion'),
    // Every string method reading into the text.
    ...['split(":")', 'slice(0, 4)', 'substring(1)', 'indexOf(":")', 'lastIndexOf(":")', 'startsWith("blob")',
      'endsWith("x")', 'includes(":")', 'match(/:/)', 'replace(":", "/")', 'replaceAll(":", "/")', 'at(0)', 'charAt(0)']
      .map((call) => flagged(`const read = key.${call};`, 'stringMethod')),
    // Reached through optional chaining, a computed name, a parameter and a type parameter.
    flagged('const read = maybe?.slice(0, 4);', 'stringMethod'),
    flagged("const read = key['slice'](0, 4);", 'stringMethod'),
    flagged('function f(k: ContentKey): string { return k.slice(0, 4); }', 'stringMethod'),
    flagged('function f<K extends ContentKey>(k: K): string { return k.slice(0, 4); }', 'stringMethod'),
    flagged('const read = keys.map((k) => k.split(":"));', 'stringMethod'),
    // Ordering through the comparators, either side.
    flagged('const order = compareCodeUnits(key, text);', 'comparator'),
    flagged('const order = compareCodeUnits(text, other);', 'comparator'),
    flagged('const sorted = [...keys].sort(compareCodeUnits);', 'comparator'),
    flagged('const order = key.localeCompare(text);', 'comparator'),
    flagged('const order = text.localeCompare(key);', 'comparator'),
    // Two keys compared by text.
    flagged('const same = key === other;', 'equality'),
    flagged('const differ = key !== other;', 'equality'),
    // The allowlist is anchored: a same-named file elsewhere, and a sibling of the parser, are linted.
    { ...flagged('const read = key.slice(0, 4);', 'stringMethod', typedCaseFile('vendor/content-key.ts')), options: ALLOW },
    { ...flagged('const read = key.slice(0, 4);', 'stringMethod', typedCaseFile('packages/resources/src/content-key-cache.ts')), options: ALLOW },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => { expectTypedRulePasses(RULE, CASES); });

  it('refuses to run without type information rather than report nothing', () => {
    const untyped = { valid: [{ code: 'const cut = key.slice(0, 4);', filename: '/repo/packages/cli/src/consumer.ts' }], invalid: [] };
    expect(() => { ruleTester.run(RULE, loadLocalRule(`${RULE}.cjs`), untyped); }).toThrow(/needs type information/u);
  });
});
