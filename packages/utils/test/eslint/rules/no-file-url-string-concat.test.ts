import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const CASES: RuleCases = {
  valid: [
    { code: "import { pathToFileURL } from 'node:url'; const u = pathToFileURL(process.argv[1]).href;" },
    { code: "if (path.startsWith('file://')) {}" },
    { code: "const u = 'file://example.com';" },
    { code: "const u = `file://example.com`;" },
    { code: "new URL('file:///abs/path');" },
    { code: "const s = 'hello' + name;" },
  ],
  invalid: [
    { code: 'const u = `file://${process.argv[1]}`;', errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "if (import.meta.url === `file://${process.argv[1]}`) {}", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "const u = 'file://' + somePath;", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "const u = somePath + 'file://abc';", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: 'const u = `file:///${drive}/${rest}`;', errors: [{ messageId: 'useFileUrlBuilder' }] },
  ],
};

describe('no-file-url-string-concat', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-file-url-string-concat', CASES); });
});
