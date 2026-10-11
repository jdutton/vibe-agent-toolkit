/**
 * `no-existssync` — product source may not ask `existsSync`, which answers
 * `false` for a path it could not look at (`EACCES`, `ELOOP`) exactly as for
 * one that is not there. The VALID cases pin the scope (tests, test-support
 * and anything outside `packages/*\/src/` are not linted) and the decoys a
 * name match alone would catch; the INVALID ones pin every way the function
 * reaches a call: a named import (aliased too), a namespace or default import,
 * `require` / dynamic `import`, a destructure, a value reference and a re-export.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-existssync';
const SRC = '/repo/packages/cli/src/commands/build.ts';
const NESTED_SRC = '/repo/packages/claude-marketplace/src/inventory/extract-plugin.ts';
const TEST_FILE = '/repo/packages/cli/test/commands/build.test.ts';
const TEST_SUPPORT = '/repo/packages/cli/test/helpers/fixture.ts';
const OUTSIDE = '/repo/scripts/release.ts';
const RATCHET = 'packages/cli/src/commands/build.ts';
const NAMED = "import { existsSync } from 'node:fs'; if (existsSync(p)) go();";

const CASES: RuleCases = {
  valid: [
    // Out of scope: tests, test-support, anything not under a package's src.
    { code: NAMED, filename: TEST_FILE },
    { code: NAMED, filename: TEST_SUPPORT },
    { code: NAMED, filename: OUTSIDE },
    // The replacement.
    { code: "import { pathPresent } from '@vibe-agent-toolkit/utils'; if (pathPresent(p, 'follow', 'source', 'probe')) go();", filename: SRC },
    // Decoys: a same-named function that is not node:fs's, and a receiver that is not fs.
    { code: "import { existsSync } from './my-fs.js'; existsSync(p);", filename: SRC },
    { code: 'const existsSync = (p: string) => p.length > 0; existsSync(p);', filename: SRC },
    { code: "import * as fs from 'node:fs'; store.existsSync(p);", filename: SRC },
    { code: "import fs from 'node:fs'; fs.statSync(p);", filename: SRC },
    { code: "require('node:fs').statSync(p); require('./my-fs.js').existsSync(p);", filename: SRC },
    // A type-only import binds nothing callable.
    { code: "import type { PathLike } from 'node:fs';", filename: SRC },
    // The ratchet, by full repo-relative path.
    { code: NAMED, filename: `/repo/${RATCHET}`, options: [{ allowFiles: [RATCHET] }] },
  ],
  invalid: [
    { code: NAMED, filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: NAMED, filename: NESTED_SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "import { existsSync } from 'fs'; existsSync(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // Aliased: the local name is what is called.
    { code: "import { existsSync as exists } from 'node:fs'; exists(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // Handed on as a value is the same answer.
    { code: "import { existsSync } from 'node:fs'; paths.filter(existsSync);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // Two uses, two reports.
    { code: "import { existsSync } from 'node:fs'; existsSync(a); existsSync(b);", filename: SRC, errors: [{ messageId: 'existsSync' }, { messageId: 'existsSync' }] },
    // Namespace and default imports.
    { code: "import * as fs from 'node:fs'; fs.existsSync(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "import fs from 'fs'; if (fs.existsSync(p)) go();", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "import nodeFs from 'node:fs'; nodeFs['existsSync'](p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // require / dynamic import.
    { code: "const fs = require('node:fs'); fs.existsSync(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "const fs = await import('node:fs'); fs.existsSync(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "const fs = require('node:fs') as typeof FsModule; const deps = { existsSync: fs.existsSync };", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "import fs = require('node:fs'); fs.existsSync(p);", filename: '/repo/packages/lab/src/facets/io/counter.cts', errors: [{ messageId: 'existsSync' }] },
    // Read straight off the loading expression, with no binding in between.
    { code: "if ((await import('node:fs')).existsSync(p)) go();", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "require('fs').existsSync(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "const probe = (require('node:fs') as typeof FsModule)['existsSync'];", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // Laundered through a destructure.
    { code: "import * as fs from 'node:fs'; const { existsSync } = fs; existsSync(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "const { existsSync: exists } = require('fs'); exists(p);", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // Laundered through a re-export.
    { code: "export { existsSync } from 'node:fs';", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    { code: "export * from 'fs';", filename: SRC, errors: [{ messageId: 'existsSync' }] },
    // Windows separators.
    { code: NAMED, filename: String.raw`C:\repo\packages\cli\src\run.ts`, errors: [{ messageId: 'existsSync' }] },
    // The ratchet names ONE file.
    { code: NAMED, filename: NESTED_SRC, options: [{ allowFiles: [RATCHET] }], errors: [{ messageId: 'existsSync' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
