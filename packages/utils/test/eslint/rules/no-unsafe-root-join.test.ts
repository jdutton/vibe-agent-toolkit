import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

const CASES: RuleCases = {
  valid: [
    // joinUnderRoot — already the safe call, not flagged
    { code: 'safePath.joinUnderRoot(harnessRoot, name);' },
    // First arg does NOT end in 'root' — not a security root join, not flagged
    { code: 'safePath.join(baseDir, name);' },
    { code: 'safePath.join(pluginDir, name);' },
    { code: 'safePath.resolve(outputDir, name);' },
    // Non-safePath member expression — not our rule
    { code: "path.join(harnessRoot, 'sub');"},
    // safePath.relative is not join/resolve — not flagged
    { code: "safePath.relative(harnessRoot, dest);" },
    // No arguments — not flagged
    { code: "safePath.join();" },
  ],
  invalid: [
    {
      code: 'safePath.join(harnessRoot, name);',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.join(stagedRoot, "subdir");',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.join(pluginRoot, stagedDirName(item));',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.resolve(harnessRoot, segment);',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      // Mixed-case 'Root' suffix
      code: 'safePath.join(outputROOT, "child");',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
  ],
};

describe('no-unsafe-root-join', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-unsafe-root-join', CASES); });
});
