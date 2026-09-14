/**
 * `no-fs-promises-cp` — the one factory rule whose safe replacement is a Node
 * builtin (`cpSync` from `node:fs`) rather than a helper from this package, so
 * `{{safeModule}}` resolves to `node:fs` and the fixer rewrites one builtin
 * import into another. Until this suite existed the rule had exactly one
 * positive snippet (in the placeholder-rendering suite) and no valid cases.
 */

import { describe, it } from 'vitest';

import { unsafeCallRuleCases } from '../factory-cases.js';
import { NODE_FS, RULE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES } from '../rule-tester.js';

describe(RULE.cp, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE.cp, unsafeCallRuleCases({
      unsafeFn: 'cp', unsafeModule: 'node:fs/promises', safeFn: 'cpSync',
      safeModule: NODE_FS, exemptPath: 'packages/utils/src/copy-tree.ts',
    }));
  });
});
