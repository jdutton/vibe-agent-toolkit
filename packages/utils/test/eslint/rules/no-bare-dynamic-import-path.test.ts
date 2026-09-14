import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const CASES: RuleCases = {
  valid: [
    { code: "await import('./relative.js');" },
    { code: "await import('../sibling.js');" },
    { code: "await import('some-pkg');" },
    { code: "await import('@scope/pkg');" },
    { code: "import { pathToFileURL } from 'node:url'; const p = '/abs'; await import(pathToFileURL(p).href);" },
    { code: 'const spec = "./x.js"; await import(spec);' },
  ],
  invalid: [
    { code: "await import('/Users/foo/x.js');", errors: [{ messageId: 'useFileUrl' }] },
    { code: String.raw`await import('C:\\x.js');`, errors: [{ messageId: 'useFileUrl' }] },
    { code: "import path from 'node:path'; await import(path.join(dir, 'x.js'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: "import path from 'node:path'; await import(path.resolve('x'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: "import { join } from 'node:path'; await import(join(dir, 'x.js'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: 'const absPath = "/x"; await import(absPath);', errors: [{ messageId: 'useFileUrl' }] },
    { code: 'const configFile = "/x"; await import(configFile);', errors: [{ messageId: 'useFileUrl' }] },
    { code: "import { join } from 'node:path'; await import(`${join(dir, 'x.js')}`);", errors: [{ messageId: 'useFileUrl' }] },
  ],
};

describe('no-bare-dynamic-import-path', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-bare-dynamic-import-path', CASES); });
});
