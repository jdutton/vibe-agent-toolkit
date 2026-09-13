/**
 * `no-io-in-unit-tier` — a unit-tier test file may not spawn a process or
 * mint a temp directory. The VALID cases pin the tier boundary from every
 * side (integration/system directories AND suffixes, non-test files, files
 * outside `packages/*\/test/`) plus the ratchet; the INVALID ones pin each
 * banned import and call shape inside a plain unit file.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-io-in-unit-tier';
const UNIT = '/repo/packages/resources/test/parse.test.ts';
const NESTED_UNIT = '/repo/packages/cli/test/commands/corpus/runner.test.ts';
const INTEGRATION_DIR = '/repo/packages/resources/test/integration/parse.integration.test.ts';
const INTEGRATION_SUFFIX = '/repo/packages/resources/test/parse.integration.test.ts';
const SYSTEM_DIR = '/repo/packages/cli/test/system/exit-codes.system.test.ts';
const SYSTEM_SUFFIX = '/repo/packages/cli/test/exit-codes.system.test.ts';
const HELPER = '/repo/packages/resources/test/test-helpers.ts';
const OUTSIDE = '/repo/scripts/smoke.test.ts';
const RATCHET = 'packages/cli/test/commands/corpus/runner.test.ts';
const SPAWN_IMPORT = "import { spawnSync } from 'node:child_process';";
const MKDTEMP = "const dir = mkdtempSync(safePath.join(tmpdir(), 'x-'));";

const CASES: RuleCases = {
  valid: [
    // The other tiers own I/O.
    { code: SPAWN_IMPORT, filename: INTEGRATION_DIR },
    { code: SPAWN_IMPORT, filename: INTEGRATION_SUFFIX },
    { code: MKDTEMP, filename: SYSTEM_DIR },
    { code: MKDTEMP, filename: SYSTEM_SUFFIX },
    // Not a test file, or not under a package test directory.
    { code: SPAWN_IMPORT, filename: HELPER },
    { code: MKDTEMP, filename: OUTSIDE },
    { code: SPAWN_IMPORT, filename: '/repo/packages/cli/src/run.ts' },
    // A unit file that does pure work.
    { code: "import { parse } from '../src/parse.js'; expect(parse('x')).toEqual([]);", filename: UNIT },
    { code: "import { mkdtempSync } from 'node:fs';", filename: UNIT },
    // A type import of child_process is not a spawn.
    { code: "import type { SpawnOptions } from 'node:child_process';", filename: UNIT },
    // A mocked spawn is declared, not called.
    { code: "vi.mock('node:child_process');", filename: UNIT },
    // The ratchet, by full repo-relative path.
    { code: SPAWN_IMPORT, filename: `/repo/${RATCHET}`, options: [{ allowFiles: [RATCHET] }] },
  ],
  invalid: [
    { code: SPAWN_IMPORT, filename: UNIT, errors: [{ messageId: 'childProcessImport', data: { source: 'node:child_process' } }] },
    { code: "import { execSync } from 'child_process';", filename: UNIT, errors: [{ messageId: 'childProcessImport' }] },
    { code: "import * as cp from 'node:child_process';", filename: UNIT, errors: [{ messageId: 'childProcessImport' }] },
    { code: "const cp = await import('node:child_process');", filename: UNIT, errors: [{ messageId: 'childProcessImport' }] },
    { code: MKDTEMP, filename: UNIT, errors: [{ messageId: 'ioCall', data: { name: 'mkdtempSync' } }] },
    { code: "const dir = await mkdtemp(prefix);", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    { code: "const dir = fs.mkdtempSync(prefix);", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    { code: "const r = spawnSync('git', ['status']);", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    { code: "const child = spawn('node', [bin]);", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    { code: "execSync('git init');", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    { code: "execFileSync('git', ['init']);", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    { code: "cp.execFileSync('git', ['init']);", filename: UNIT, errors: [{ messageId: 'ioCall' }] },
    // Nested under the package test directory is still the unit tier.
    { code: MKDTEMP, filename: NESTED_UNIT, errors: [{ messageId: 'ioCall' }] },
    // Windows separators.
    { code: MKDTEMP, filename: String.raw`C:\repo\packages\cli\test\run.test.ts`, errors: [{ messageId: 'ioCall' }] },
    // Import and call in one file: two reports.
    { code: `${SPAWN_IMPORT} spawnSync('git', []);`, filename: UNIT, errors: [{ messageId: 'childProcessImport' }, { messageId: 'ioCall' }] },
    // The ratchet names ONE file.
    { code: SPAWN_IMPORT, filename: UNIT, options: [{ allowFiles: [RATCHET] }], errors: [{ messageId: 'childProcessImport' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
