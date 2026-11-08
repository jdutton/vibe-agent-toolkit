import { describe, it } from 'vitest';

import { seamSignatureCases, unsafeCallRuleCases } from '../factory-cases.js';
import { NODE_CHILD_PROCESS, RULE, SAFE_EXEC_IMPL, SAFE_PROCESS_MODULE, SEAM } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

const ARGV_FROM_SHELL_STRING = 'ARGV_FROM_SHELL_STRING';

describe(RULE.execSync, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE.execSync, unsafeCallRuleCases({
      unsafeFn: 'execSync', unsafeModule: NODE_CHILD_PROCESS, safeFn: 'safeExecSync',
      safeModule: SAFE_PROCESS_MODULE, exemptPath: SAFE_EXEC_IMPL,
      rewrite: { appendArgument: ARGV_FROM_SHELL_STRING },
    }));
  });

  it('names no call shape and suggests nothing when safeModule is a consumer seam', () => {
    expectRulePasses(RULE.execSync, seamSignatureCases({
      unsafeFn: 'execSync', unsafeModule: NODE_CHILD_PROCESS, safeFn: 'safeExecSync', appendArgument: ARGV_FROM_SHELL_STRING,
      seamMessage:
        `Use safeExecSync from ${SEAM} instead of child_process.execSync() to prevent command injection (security + cross-platform); ` +
        'pass it the binary and its arguments separately, not a shell string',
    }));
  });
});
