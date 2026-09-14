import { describe, it } from 'vitest';

import { LINTED_FILE } from '../fixtures.js';
import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * `no-bare-symlink-in-tests` fires on BOTH sides of the test boundary, with a
 * different `messageId` on each — `noBareSymlink` in test files, where
 * `createSymlink(cap, …)` is the remedy, and `unguardedSymlink` in shipped
 * code, where it is not (that helper lives on the `utils/testing` subpath, so
 * pointing production at it would be worse advice than the bare call). Both ids
 * are asserted below so the two remedies cannot silently collapse into one.
 *
 * No auto-fix: the replacement needs a capability token threaded from a probe
 * call, a placement judgment a mechanical fixer cannot make.
 *
 * The exempt path deliberately ends in `.test.ts` (a real backlog entry, not
 * the implementation file) so the anchoring decoy below actually exercises
 * `exempt-path-matcher.cjs` rather than being filtered out by `isTestFile`
 * first for an unrelated reason.
 */
const SYMLINK_TEST_FILE = 'packages/cli/test/example.test.ts';
const SYMLINK_EXEMPT = 'packages/resources/test/resolve-local-href.test.ts';
const SYMLINK_SYNC_NAMED = "import { symlinkSync } from 'node:fs';\nsymlinkSync(a, b);";
const SYMLINK_SYNC_MEMBER = "import fs from 'node:fs';\nfs.symlinkSync(a, b);";
const SYMLINK_ASYNC_MEMBER = "import fs from 'node:fs/promises';\nawait fs.symlink(a, b);";
const SYMLINK_ASYNC_NAMED = "import { symlink } from 'node:fs/promises';\nawait symlink(a, b);";
const SYMLINK_ASYNC_CHAINED_MEMBER = "import fs from 'node:fs';\nawait fs.promises.symlink(a, b);";
const CASES: RuleCases = {
  valid: [
    { code: SYMLINK_SYNC_NAMED, filename: SYMLINK_EXEMPT, options: [{ exemptFiles: [SYMLINK_EXEMPT] }] },
    { code: SYMLINK_SYNC_NAMED, filename: `/Users/dev/vat/${SYMLINK_EXEMPT}`, options: [{ exemptFiles: [SYMLINK_EXEMPT] }] },
    // A same-named method on an unrelated receiver is not this module's call.
    {
      code: "const env = { symlinkSync: () => {} };\nenv.symlinkSync();",
      filename: SYMLINK_TEST_FILE,
      options: [{ exemptFiles: [SYMLINK_EXEMPT] }],
    },
  ],
  invalid: [
    { code: SYMLINK_SYNC_NAMED, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_SYNC_MEMBER, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_ASYNC_MEMBER, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_ASYNC_NAMED, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_ASYNC_CHAINED_MEMBER, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    // DECOY — same basename as the exempt entry, different directory: must still fire.
    { code: SYMLINK_SYNC_NAMED, filename: 'packages/other/test/resolve-local-href.test.ts', options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    // Shipped code is covered too, with the OTHER message. It cannot `skip()`,
    // and `createSymlink()` lives on the `utils/testing` subpath, so pointing
    // production code at a test helper would be worse advice than the bare
    // call — hence a distinct messageId rather than a reworded one.
    // Asserting the id, not just "it errors", is what stops the two remedies
    // silently collapsing into one.
    { code: SYMLINK_SYNC_NAMED, filename: LINTED_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'unguardedSymlink' }] },
    { code: SYMLINK_ASYNC_MEMBER, filename: LINTED_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'unguardedSymlink' }] },
    // UNCONFIGURED — with no `exemptFiles` option nothing is exempt, including the backlog path.
    { code: SYMLINK_SYNC_NAMED, filename: SYMLINK_EXEMPT, errors: [{ messageId: 'noBareSymlink' }] },
    // An unanchored `exemptFiles` entry is reported, exactly as every other
    // consumer of `exempt-path-matcher.cjs` reports it. Extending this rule past
    // test files is what made `exemptFiles` load-bearing here, and it shipped
    // the option without the advisory the matcher module documents as
    // mandatory — so a bare basename silently exempted that name tree-wide.
    {
      code: SYMLINK_SYNC_NAMED,
      filename: LINTED_FILE,
      options: [{ exemptFiles: ['test-helpers.ts'] }],
      errors: [{ messageId: 'unanchoredExemptFile' }, { messageId: 'unguardedSymlink' }],
    },
    // …and on the file the bare entry DOES match, which is exempt only because
    // the entry is unanchored. The symlink finding is correctly suppressed; the
    // advisory is what stops that suppression being invisible.
    {
      code: SYMLINK_SYNC_NAMED,
      filename: 'packages/anything/src/deep/test-helpers.ts',
      options: [{ exemptFiles: ['test-helpers.ts'] }],
      errors: [{ messageId: 'unanchoredExemptFile' }],
    },
  ],
};

describe('no-bare-symlink-in-tests', () => {
  it(RULE_TESTER_CASES, () => { expectRulePasses('no-bare-symlink-in-tests', CASES); });
});
