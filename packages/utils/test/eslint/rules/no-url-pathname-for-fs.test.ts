import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const CASES: RuleCases = {
  valid: [
    { code: "import { fileURLToPath } from 'node:url'; const p = fileURLToPath(new URL('../x', import.meta.url));" },
    { code: "const p = new URL('http://example.com').pathname;" },
    { code: 'const p = someUrl.pathname;' },
    { code: "const u = new URL('../x', import.meta.url); const s = u.href;" },
  ],
  invalid: [
    { code: 'const p = new URL(rel, import.meta.url).pathname;', errors: [{ messageId: 'useFileURLToPath' }] },
    { code: "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;", errors: [{ messageId: 'useFileURLToPath' }] },
    { code: 'const p = new URL(`../fixtures/${name}.yaml`, import.meta.url).pathname;', errors: [{ messageId: 'useFileURLToPath' }] },
  ],
};

describe('no-url-pathname-for-fs', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-url-pathname-for-fs', CASES); });
});
