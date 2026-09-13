import { describe, it } from 'vitest';

import { unsafeCallRuleCases } from '../factory-cases.js';
import { NODE_CHILD_PROCESS, RULE, SAFE_EXEC_IMPL, SAFE_PROCESS_MODULE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

describe(RULE.execSync, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE.execSync, unsafeCallRuleCases({
      unsafeFn: 'execSync', unsafeModule: NODE_CHILD_PROCESS, safeFn: 'safeExecSync',
      safeModule: SAFE_PROCESS_MODULE, exemptPath: SAFE_EXEC_IMPL,
    }));
  });
});
