/**
 * `content-key-opaque` — a `ContentKey` is opaque outside its one parser: no cast mints one (or an
 * array or object of them), no member access, index, spread, destructure, iteration or regex call
 * reads into one, no `compareCodeUnits`/`localeCompare` orders one. Equality is the whole text, so
 * `===` between two keys is the contract and is not reported. The brand is found through the type checker, so the VALID cases pin the decoys a
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
    // Equality is the whole text: `===`, `!==`, `==` and `Object.is` between keys are the contract.
    at('const same = key === other; const differ = key !== other; const loose = key == other; const is = Object.is(key, other);'),
    // Passing a key along: an argument, a return, a property value, a template literal, a Map key.
    at('const row = { key }; const label = `${key}`; const byKey = new Map([[key, 1]]); const got = byKey.get(key);'),
    // A cast whose source is already keyed mints nothing: a widening, an empty array, an object of keys.
    at('const all = keys as readonly ContentKey[]; const one = [key] as ContentKey[]; const none = [] as ContentKey[]; const row = { key } as { key: ContentKey };'),
    // `as const` narrows literals; it makes nothing a key.
    at('const pair = [key, text.length] as const;'),
    // A partial row whose key field is a key already, or `null`, mints nothing: the other fields are not keys.
    at('type Row = { key: ContentKey | null; path: string; size: number }; const a = { key, path: text } as Row; const b = { key: null, path: text } as Row;'),
    // The floor: keys deeper than one level (a table of rows, a projection) are not searched.
    at('const rows = JSON.parse(text) as { rows: readonly { blob: ContentKey }[] };'),
    // An assertion from a value already keyed mints nothing: narrowing away `undefined`.
    at('const first = keys[0] as ContentKey; const sure = maybe as ContentKey; const same = key as ContentKey;'),
    // Ordering by bare sort or `<`/`>` is harmless: key order equals text order.
    at('const sorted = [...keys].sort(); const less = key < other;'),
    // A string method on a plain string, and on an array OF keys (Array#includes, Array#at).
    at("const cut = text.slice(0, 4); const has = text.includes(':');"),
    at('const has = keys.includes(key); const first = keys.at(0);'),
    // A key handed to a function that takes a string is not a read of its text.
    at('const length = String(key).length;'),
    // A key compared with a plain string, and a regex run over a plain string.
    at('const same = key === text; const hit = /x/u.test(text);'),
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
    // A cast to an array, record, object or container OF keys from values that are not keys.
    flagged('const minted = [text] as ContentKey[];', 'assertion'),
    flagged('const minted = JSON.parse(text) as Record<string, ContentKey>;', 'assertion'),
    flagged('const minted = { key: text } as { key: ContentKey };', 'assertion'),
    flagged('const minted = new Map<string, string>() as unknown as Map<string, ContentKey>;', 'assertion'),
    flagged('type Row = { key: ContentKey | null; path: string }; const minted = { key: text, path: text } as Row;', 'assertion'),
    // Any member access reads into the text: every string method, and every property.
    ...['split(":")', 'slice(0, 4)', 'substring(1)', 'substr(1)', 'indexOf(":")', 'lastIndexOf(":")', 'startsWith("blob")',
      'endsWith("x")', 'includes(":")', 'match(/:/)', 'matchAll(/:/g)', 'search(/:/)', 'replace(":", "/")',
      'replaceAll(":", "/")', 'at(0)', 'charAt(0)', 'charCodeAt(0)', 'codePointAt(0)', 'toString()', 'valueOf()',
      'localeCompare(text)', 'length']
      .map((access) => flagged(`const read = key.${access};`, 'read')),
    // Indexing, spread, destructure and iteration read the characters.
    flagged('const read = key[0];', 'read'),
    flagged('const read = [...key];', 'read'),
    flagged('const read = { ...key };', 'read'),
    flagged('const [first] = key;', 'read'),
    flagged('const { length } = key;', 'read'),
    flagged('let first: string | undefined; [first] = key;', 'read'),
    flagged('for (const char of key) { void char; }', 'read'),
    // A key handed to a regex runs the pattern over its text.
    flagged('const read = /:/u.test(key);', 'read'),
    flagged('const read = /:/u.exec(other);', 'read'),
    // Reached through optional chaining, a computed name, a parameter and a type parameter.
    flagged('const read = maybe?.slice(0, 4);', 'read'),
    flagged('const read = maybe?.length;', 'read'),
    flagged("const read = key['slice'](0, 4);", 'read'),
    flagged('function f(k: ContentKey): string { return k.slice(0, 4); }', 'read'),
    flagged('function f<K extends ContentKey>(k: K): string { return k.slice(0, 4); }', 'read'),
    flagged('const read = keys.map((k) => k.split(":"));', 'read'),
    // Ordering through the comparators, either side.
    flagged('const order = compareCodeUnits(key, text);', 'comparator'),
    flagged('const order = compareCodeUnits(text, other);', 'comparator'),
    flagged('const sorted = [...keys].sort(compareCodeUnits);', 'comparator'),
    flagged('const order = text.localeCompare(key);', 'comparator'),
    // The allowlist is anchored: a same-named file elsewhere, and a sibling of the parser, are linted.
    { ...flagged('const read = key.slice(0, 4);', 'read', typedCaseFile('vendor/content-key.ts')), options: ALLOW },
    { ...flagged('const read = key.slice(0, 4);', 'read', typedCaseFile('packages/resources/src/content-key-cache.ts')), options: ALLOW },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => { expectTypedRulePasses(RULE, CASES); });

  it('refuses to run without type information rather than report nothing', () => {
    const untyped = { valid: [{ code: 'const cut = key.slice(0, 4);', filename: '/repo/packages/cli/src/consumer.ts' }], invalid: [] };
    expect(() => { ruleTester.run(RULE, loadLocalRule(`${RULE}.cjs`), untyped); }).toThrow(/needs type information/u);
  });
});
