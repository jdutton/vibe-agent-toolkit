import { describe, it } from 'vitest';

import { unsafeCallRuleCases } from '../factory-cases.js';
import { NODE_FS, PATH_UTILS_IMPL, RULE, SAFE_FS_MODULE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

describe(RULE.mkdir, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE.mkdir, unsafeCallRuleCases({
      unsafeFn: 'mkdirSync', unsafeModule: NODE_FS, safeFn: 'mkdirSyncReal',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }));
  });
});
