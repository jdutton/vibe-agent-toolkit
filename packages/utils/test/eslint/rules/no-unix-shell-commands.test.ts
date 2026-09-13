import { describe, it } from 'vitest';

import { LINTED_FILE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * `no-unix-shell-commands` exempts test files, because the tests for the detector
 * necessarily name the banned commands. That exemption was
 * `filename.includes('.test.ts')`, which is a CATEGORY check written as an
 * unanchored substring: it also exempted `example.test.ts.bak`, a `.test.ts`
 * directory, and (really, in this repo) `tsconfig.test.json` via `.test.js`.
 * The valid legs prove genuine test files are STILL exempt — without them the
 * rule could be "fixed" by exempting nothing and this suite would stay green.
 */
const UNIX_CMD_CODE = "safeExecSync('tar', ['xzf', archive]);";
const UNIX_TEST_FILE = 'packages/utils/test/eslint/example.test.ts';
const CASES: RuleCases = {
  valid: [
    { code: "safeExecSync('node', [script]);", filename: LINTED_FILE },
    { code: UNIX_CMD_CODE, filename: UNIX_TEST_FILE },
    { code: UNIX_CMD_CODE, filename: `/Users/dev/vat/${UNIX_TEST_FILE}` },
    { code: UNIX_CMD_CODE, filename: String.raw`C:\dev\vat\packages\utils\test\eslint\example.test.ts` },
  ],
  invalid: [
    { code: UNIX_CMD_CODE, filename: LINTED_FILE, errors: [{ messageId: 'noUnixCommand' }] },
    { code: "execSync('tar xzf x.tgz');", filename: LINTED_FILE, errors: [{ messageId: 'noUnixCommand' }] },
    // DECOYS — every one of these linted clean under the substring exemption.
    { code: UNIX_CMD_CODE, filename: 'packages/cli/src/example.test.ts.bak', errors: [{ messageId: 'noUnixCommand' }] },
    { code: UNIX_CMD_CODE, filename: 'packages/cli/src/.test.ts-helpers/impl.ts', errors: [{ messageId: 'noUnixCommand' }] },
  ],
};

describe('no-unix-shell-commands', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-unix-shell-commands', CASES); });
});
