/**
 * `no-bare-executable-spawn` — a spawn-family call may not name `git` or
 * `node` as a bare string. The VALID cases pin what a resolved path looks
 * like and that other executables and non-literal arguments are out of scope;
 * the INVALID ones pin every call shape, bare and namespaced, in source and
 * test files alike (the rule has no tier boundary and no allowlist).
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-bare-executable-spawn';
const SRC = '/repo/packages/cli/src/run.ts';
const TEST = '/repo/packages/cli/test/system/run.system.test.ts';

const CASES: RuleCases = {
  valid: [
    { code: "spawnSync(gitExecutable(), ['status'], { cwd });", filename: TEST },
    { code: 'spawnSync(NODE_EXECUTABLE, [bin, ...args]);', filename: TEST },
    { code: 'spawnSync(process.execPath, [bin]);', filename: SRC },
    // Another executable is another rule's business.
    { code: "spawnSync('bun', ['install']);", filename: TEST },
    // A variable is not a bare literal — the resolver above it is what this rule asks for.
    { code: "const git = resolve('git'); spawnSync(git, ['init']);", filename: TEST },
    // The strings alone are not spawns.
    { code: "const names = ['git', 'node'];", filename: SRC },
    { code: "which.sync('git');", filename: SRC },
  ],
  invalid: [
    { code: "spawnSync('git', ['status']);", filename: TEST, errors: [{ messageId: 'bareName', data: { call: 'spawnSync', name: 'git' } }] },
    { code: "spawn('node', [bin]);", filename: SRC, errors: [{ messageId: 'bareName', data: { call: 'spawn', name: 'node' } }] },
    { code: "execFileSync('git', ['init']);", filename: TEST, errors: [{ messageId: 'bareName' }] },
    { code: "execFile('node', [bin], cb);", filename: SRC, errors: [{ messageId: 'bareName' }] },
    { code: "execSync('git');", filename: TEST, errors: [{ messageId: 'bareName' }] },
    { code: "cp.spawnSync('git', ['init']);", filename: TEST, errors: [{ messageId: 'bareName' }] },
    { code: "childProcess.spawn('node', []);", filename: SRC, errors: [{ messageId: 'bareName' }] },
    // Two calls, two reports.
    { code: "spawnSync('git', []); spawnSync('node', []);", filename: TEST, errors: [{ messageId: 'bareName' }, { messageId: 'bareName' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
