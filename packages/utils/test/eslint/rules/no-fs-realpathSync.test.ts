import { describe, it } from 'vitest';

import { unsafeCallRuleCases } from '../factory-cases.js';
import { NODE_FS, PATH_UTILS_IMPL, RULE, SAFE_FS_MODULE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

describe(RULE.realpath, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE.realpath, unsafeCallRuleCases({
      unsafeFn: 'realpathSync', unsafeModule: NODE_FS, safeFn: 'normalizePath',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }));
  });
});
