/**
 * `no-manual-path-normalize` has its own fixer (not a factory's), so it gets
 * its own `safeModule` leg — once per code path that WRITES an import.
 */

import { describe, it } from 'vitest';

import { safeModuleCases } from '../factory-cases.js';
import { LINTED_FILE, RULE, SEAM } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const seam = safeModuleCases(
  "const n = p.split(path.sep).join('/');",
  `import { toForwardSlash } from '${SEAM}';\nconst n = toForwardSlash(p);`,
  [{ messageId: 'useToForwardSlash' }],
);

const CASES: RuleCases = {
  ...seam,
  valid: [
    ...seam.valid,
    // Splitting on a TWO-backslash SEQUENCE — source literal
    // String.raw`'\\\\'`, decoded value: two backslash characters —
    // is a different, rarer operation (e.g. collapsing a UNC path's
    // leading double-backslash server prefix) than splitting on
    // path.sep. toForwardSlash() is not equivalent to it, so this must
    // NOT be treated as the path.sep-style split the rule autofixes —
    // it stays valid (unflagged).
    { code: String.raw`const n = p.split('\\\\').join('/');`, filename: LINTED_FILE },
  ],
};

describe(RULE.normalize, () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses(RULE.normalize, CASES); });
});
