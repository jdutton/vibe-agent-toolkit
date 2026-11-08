import { describe, it } from 'vitest';

import { seamSignatureCases, unsafeCallRuleCases } from '../factory-cases.js';
import { NODE_FS, PATH_UTILS_IMPL, RULE, SAFE_FS_MODULE, SEAM } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

const TREE_CRAWLED_IN = '{ within: TREE_CRAWLED_IN }';

describe(RULE.realpath, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE.realpath, unsafeCallRuleCases({
      unsafeFn: 'realpathSync', unsafeModule: NODE_FS, safeFn: 'normalizePath',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
      rewrite: { appendArgument: TREE_CRAWLED_IN },
    }));
  });

  it('names no call shape and suggests nothing when safeModule is a consumer seam', () => {
    expectRulePasses(RULE.realpath, seamSignatureCases({
      unsafeFn: 'realpathSync', unsafeModule: NODE_FS, safeFn: 'normalizePath', appendArgument: TREE_CRAWLED_IN,
      seamMessage:
        `Use normalizePath from ${SEAM} instead of fs.realpathSync() for consistent Windows 8.3 path resolution; ` +
        'its own signature governs what to pass it',
    }));
  });
});
