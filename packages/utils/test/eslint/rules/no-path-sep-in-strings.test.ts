/**
 * `no-path-sep-in-strings` — `path.sep` handed to a string method, spliced into
 * a template literal, or concatenated. Keyed on the literal member `path.sep`,
 * so the VALID rows pin what is NOT that member: a `sep` on another object, a
 * `path.sep` read on its own, and `path.delimiter`.
 */

import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NAME = 'no-path-sep-in-strings';
const ERR = [{ messageId: 'noPathSep' }];

const CASES: RuleCases = {
  valid: [
    // Reading the separator is not a string operation.
    { code: 'const s = path.sep;' },
    { code: 'if (path.sep === "/") {}' },
    // Another object's `sep`, and another member of `path`.
    { code: "const parts = p.split(opts.sep);" },
    { code: 'const parts = p.split(path.delimiter);' },
    // The normalized form the message recommends.
    { code: "const parts = toForwardSlash(p).split('/');" },
    // A string method not on the list.
    { code: 'const n = p.localeCompare(path.sep);' },
    // A template with no `path.sep` in it, and a concatenation of two others.
    { code: 'const s = `${a}/${b}`;' },
    { code: "const s = a + '/' + b;" },
  ],
  invalid: [
    { code: 'const parts = p.split(path.sep);', errors: ERR },
    { code: 'if (p.includes(path.sep)) {}', errors: ERR },
    { code: 'const i = p.indexOf(path.sep);', errors: ERR },
    { code: 'const i = p.lastIndexOf(path.sep);', errors: ERR },
    { code: 'if (p.startsWith(path.sep)) {}', errors: ERR },
    { code: 'if (p.endsWith(path.sep)) {}', errors: ERR },
    { code: "const q = p.replace(path.sep, '/');", errors: ERR },
    { code: "const q = p.replaceAll(path.sep, '/');", errors: ERR },
    // Any argument position, not just the first.
    { code: "const q = p.replace('/', path.sep);", errors: ERR },
    // Template literal and both sides of a concatenation.
    { code: 'const s = `${a}${path.sep}${b}`;', errors: ERR },
    { code: 'const s = a + path.sep;', errors: ERR },
    { code: 'const s = path.sep + b;', errors: ERR },
  ],
};

describe(NAME, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(NAME, CASES); });
});
