/**
 * `no-manual-path-normalize` has its own fixer (not a factory's), so it gets
 * its own `safeModule` leg — once per code path that WRITES an import, and once
 * per converter: `split(path.sep)` is a NATIVE conversion (`toForwardSlash`),
 * while a literal-backslash split or replace converts on every host and must
 * map to `toForwardSlashAnyPlatform` — autofixing it to `toForwardSlash` would
 * silently stop converting on POSIX.
 */

import { describe, it } from 'vitest';

import { safeModuleCases } from '../factory-cases.js';
import { LINTED_FILE, RULE, SEAM } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const NATIVE_ERR = [{ messageId: 'useToForwardSlash' }];
const ANY_ERR = [{ messageId: 'useToForwardSlashAnyPlatform' }];
const REPLACE_ALL_Q = String.raw`const b = q.replaceAll('\\', '/');`;
const ANY_FIXED = `import { toForwardSlashAnyPlatform } from '${SEAM}';\nconst n = toForwardSlashAnyPlatform(p);`;

const nativeSeam = safeModuleCases(
  "const n = p.split(path.sep).join('/');",
  `import { toForwardSlash } from '${SEAM}';\nconst n = toForwardSlash(p);`,
  NATIVE_ERR,
);
const splitSeam = safeModuleCases(String.raw`const n = p.split('\\').join('/');`, ANY_FIXED, ANY_ERR);
const replaceAllSeam = safeModuleCases(String.raw`const n = p.replaceAll('\\', '/');`, ANY_FIXED, ANY_ERR);
const regexSeam = safeModuleCases(String.raw`const n = p.replace(/\\/g, '/');`, ANY_FIXED, ANY_ERR);

const CASES: RuleCases = {
  valid: [
    ...nativeSeam.valid,
    ...splitSeam.valid,
    // Splitting on a TWO-backslash SEQUENCE — source literal
    // String.raw`'\\\\'`, decoded value: two backslash characters —
    // is a different, rarer operation (e.g. collapsing a UNC path's
    // leading double-backslash server prefix) than either converter.
    // It stays valid (unflagged).
    { code: String.raw`const n = p.split('\\\\').join('/');`, filename: LINTED_FILE },
    { code: String.raw`const n = p.replaceAll('\\\\', '/');`, filename: LINTED_FILE },
    // A NON-global regex replaces only the first backslash: not a converter.
    { code: String.raw`const n = p.replace(/\\/, '/');`, filename: LINTED_FILE },
    // `replace` with a string pattern replaces only the first occurrence.
    { code: String.raw`const n = p.replace('\\', '/');`, filename: LINTED_FILE },
    // Replacing with something other than '/'.
    { code: String.raw`const n = p.replaceAll('\\', '|');`, filename: LINTED_FILE },
  ],
  invalid: [
    ...nativeSeam.invalid,
    ...splitSeam.invalid,
    ...replaceAllSeam.invalid,
    ...regexSeam.invalid,
    // `replaceAll` with a global regex is the same conversion.
    {
      code: String.raw`const n = p.replaceAll(/\\/g, '/');`,
      filename: LINTED_FILE,
      options: [{ safeModule: SEAM }],
      output: ANY_FIXED,
      errors: ANY_ERR,
    },
    // A file already binding the name gains no second import.
    {
      code: `import { toForwardSlashAnyPlatform } from '${SEAM}';\n` + String.raw`const n = p.replaceAll('\\', '/');`,
      filename: LINTED_FILE,
      options: [{ safeModule: SEAM }],
      output: ANY_FIXED,
      errors: ANY_ERR,
    },
    // Both converters in one file. Their import inserts share one anchor, so ONE
    // `--fix` pass applies the first and drops the overlapping second; the next
    // pass finishes it (the autofix-fixpoint suite owns multi-pass convergence).
    {
      code: `import { safePath } from '${SEAM}';\nconst a = p.split(path.sep).join('/');\n` + REPLACE_ALL_Q,
      filename: LINTED_FILE,
      options: [{ safeModule: SEAM }],
      output:
        `import { safePath, toForwardSlash } from '${SEAM}';\n` +
        'const a = toForwardSlash(p);\n' + REPLACE_ALL_Q,
      errors: [...NATIVE_ERR, ...ANY_ERR],
    },
  ],
};

describe(RULE.normalize, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(RULE.normalize, CASES); });
});
