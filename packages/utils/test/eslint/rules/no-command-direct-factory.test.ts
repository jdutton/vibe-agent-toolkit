/**
 * `no-command-direct-factory` builds rules rather than being one, so it needs its
 * own suite. Its `exemptPackage` had the DIRECTORY flavor of the substring bug:
 * `filename.includes('packages/git/')` also exempted `vendor/copy-packages/git/`
 * and `tools/my-packages/git/` — any directory whose name merely ENDS WITH the
 * exempt one. Those are the load-bearing invalid legs below.
 */

import type { Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import { LINTED_FILE } from '../fixtures.js';
import { loadLocalRuleModule, RULE_TESTER_CASES, ruleTester } from '../rule-tester.js';

describe('no-command-direct-factory', () => {
  type CommandRuleConfig = {
    command: string;
    packageName: string;
    availableFunctions: string[];
    exemptPackage?: string;
  };
  const createNoCommandDirectRule =
    loadLocalRuleModule<(config: CommandRuleConfig) => Rule.RuleModule>('no-command-direct-factory.cjs');

  const rule = createNoCommandDirectRule({
    command: 'git',
    packageName: '@vibe-agent-toolkit/git',
    availableFunctions: ['executeGitCommand()'],
    exemptPackage: 'packages/git/',
  });
  // Deliberately the pattern this rule EXISTS to catch. It is a fixture, not a
  // call site: a bulk migration that "fixes" it silently disarms the rule's
  // entire invalid[] leg, which then passes by finding nothing to report.
  const gitCode = "safeExecSync('git', ['status']);";
  const errors = [{ messageId: 'noGitDirect' }];

  it(RULE_TESTER_CASES, () => {
    expect(() => {
      ruleTester.run('no-git-commands-direct', rule, {
        valid: [
          { code: "safeExecSync('node', [script]);", filename: LINTED_FILE },
          { code: gitCode, filename: 'packages/git/src/index.ts' },
          { code: gitCode, filename: '/Users/dev/vat/packages/git/src/index.ts' },
          { code: gitCode, filename: String.raw`C:\dev\vat\packages\git\src\index.ts` },
        ],
        invalid: [
          { code: gitCode, filename: LINTED_FILE, errors },
          { code: "execSync('git status');", filename: LINTED_FILE, errors },
          // DECOY directories — exempted by the old substring check.
          { code: gitCode, filename: 'vendor/copy-packages/git/src/index.ts', errors },
          { code: gitCode, filename: 'tools/my-packages/git/exec.ts', errors },
        ],
      });
    }).not.toThrow();
  });
});
