import { describe, it } from 'vitest';

import { expectRulePasses, RULE_TESTER_CASES, type RuleCases } from '../rule-tester.js';

/**
 * `no-destructive-fs` bans every recursive remove, rename and copy outside the
 * tree-change primitive. The exempt entries are the primitive's directory and the
 * test infrastructure that lives in `src`. The decoys share a path TAIL with an
 * exempt directory but live elsewhere, so they prove the exemption is anchored.
 */
const SRC_FILE = 'packages/cli/src/example.ts';
const PRIMITIVE_DIR = 'packages/utils/src/tree-change/';
const TESTING_DIR = 'packages/utils/src/testing/';
const TEST_HELPERS = 'packages/utils/src/test-helpers.ts';
const OPTIONS = [{ exemptFiles: [PRIMITIVE_DIR, TESTING_DIR, TEST_HELPERS] }];

const NAMED = (names: string): string => `import { ${names} } from 'node:fs';\n`;
const NAMED_FSP = (names: string): string => `import { ${names} } from 'node:fs/promises';\n`;
const DEFAULT_FS = "import fs from 'node:fs';\n";
const NS_FS = "import * as fs from 'node:fs';\n";
const FSP_DEFAULT = "import fsp from 'node:fs/promises';\n";
const PROMISES_NAMED = "import { promises } from 'node:fs';\n";
const PROMISES_ALIAS = "import { promises as fsp } from 'node:fs';\n";

function bad(code: string, messageId: string, filename = SRC_FILE): RuleCases['invalid'][number] {
  return { code, filename, options: OPTIONS, errors: [{ messageId }] };
}
function ok(code: string, filename = SRC_FILE): RuleCases['valid'][number] {
  return { code, filename, options: OPTIONS };
}

const CASES: RuleCases = {
  valid: [
    // One file is not a tree change.
    ok(`${NAMED('rm')}rm(f, { force: true });`),
    ok(`${NAMED('rmSync')}rmSync(f);`),
    ok(`${NAMED('rmSync')}rmSync(f, { recursive: false, force: true });`),
    ok(`${NAMED_FSP('unlink')}await unlink(f);`),
    ok(`${NAMED('unlinkSync')}unlinkSync(f);`),
    ok(`${DEFAULT_FS}fs.unlinkSync(f);`),
    // Reading and writing are not destructive of a tree.
    ok(`${NAMED('readFileSync, writeFileSync')}writeFileSync(a, readFileSync(b));`),
    // A same-named function that is not from node:fs.
    ok("import { rename } from './my-rename.js';\nrename(a, b);"),
    ok("import { rm } from 'fs-extra';\nrm(a, { recursive: true });"),
    ok('rm(a, { recursive: true });'),
    ok('const rm = makeRm();\nrm(a, { recursive: true });'),
    // Scope-aware: a local that shadows the imported name is not the fs function.
    ok(`${NAMED('renameSync')}function f(renameSync) { renameSync(a, b); }`),
    ok(`${NAMED('renameSync')}{ const renameSync = mine(); renameSync(a, b); }`),
    // The permitted forms stay permitted through every binding shape.
    ok(`${DEFAULT_FS}fs.rmSync(f, { force: true });`),
    ok(`${DEFAULT_FS}const { rmSync, unlinkSync } = fs;\nrmSync(f, { force: true });\nunlinkSync(f);`),
    ok("const { rm } = await import('node:fs/promises');\nawait rm(f, { force: true });"),
    ok("const fs = require('node:fs');\nfs.unlinkSync(f);"),
    ok(`${DEFAULT_FS}fs['unlinkSync'](f);`),
    ok(`${NAMED('rmSync')}rmSync(f, { recursive: false });`),
    // Exempt: the primitive, its test infrastructure, and test files.
    ok(`${NAMED('renameSync')}renameSync(a, b);`, `${PRIMITIVE_DIR}apply.ts`),
    ok(`${NAMED('renameSync')}renameSync(a, b);`, `/Users/dev/vat/${PRIMITIVE_DIR}nested/deep.ts`),
    ok(`${NAMED('cpSync')}cpSync(a, b, { recursive: true });`, `/Users/dev/vat/${TESTING_DIR}fault-fs.ts`),
    ok(`${NAMED('rmSync')}rmSync(a, { recursive: true });`, `/Users/dev/vat/${TEST_HELPERS}`),
    ok(`${NAMED('rmSync')}rmSync(a, { recursive: true });`, 'packages/cli/test/example.test.ts'),
    ok(`${NAMED('rmSync')}rmSync(a, { recursive: true });`, 'packages/cli/test/integration/example.integration.test.ts'),
  ],
  invalid: [
    // rm: recursive, or unknown.
    bad(`${NAMED('rmSync')}rmSync(d, { recursive: true });`, 'recursiveRm'),
    bad(`${NAMED('rmSync')}rmSync(d, { recursive: true, force: true });`, 'recursiveRm'),
    bad(`${NAMED_FSP('rm')}await rm(d, { force: true, recursive: true });`, 'recursiveRm'),
    bad(`${NAMED('rm')}rm(d, { recursive: flag }, cb);`, 'recursiveRm'),
    bad(`${NAMED('rmSync')}rmSync(d, options);`, 'recursiveRm'),
    bad(`${NAMED('rmSync')}rmSync(d, { ...base });`, 'recursiveRm'),
    bad(`${NAMED('rmSync')}rmSync(d, { ['recursive']: true });`, 'recursiveRm'),
    bad(`${NAMED('rmSync')}rmSync(d, makeOptions());`, 'recursiveRm'),
    bad(`${NAMED('rmSync as remove')}remove(d, { recursive: true });`, 'recursiveRm'),
    // rmdir, every shape.
    bad(`${NAMED('rmdirSync')}rmdirSync(d);`, 'rmdir'),
    bad(`${NAMED_FSP('rmdir')}await rmdir(d);`, 'rmdir'),
    bad(`${NAMED('rmdir')}rmdir(d, cb);`, 'rmdir'),
    // rename: all of them, file renames included.
    bad(`${NAMED('renameSync')}renameSync(a, b);`, 'rename'),
    bad(`${NAMED_FSP('rename')}await rename(a, b);`, 'rename'),
    bad(`${NAMED('rename')}rename(a, b, cb);`, 'rename'),
    // cp / copyFile: all of them.
    bad(`${NAMED('cpSync')}cpSync(a, b);`, 'cp'),
    bad(`${NAMED_FSP('cp')}await cp(a, b, { recursive: true });`, 'cp'),
    bad(`${NAMED('cp')}cp(a, b, cb);`, 'cp'),
    bad(`${NAMED('copyFileSync')}copyFileSync(a, b);`, 'copyFile'),
    bad(`${NAMED('copyFile')}copyFile(a, b, cb);`, 'copyFile'),
    bad(`${NAMED_FSP('copyFile')}await copyFile(a, b);`, 'copyFile'),
    // Member calls on a default, namespace, fs/promises or promises import.
    bad(`${DEFAULT_FS}fs.rmSync(d, { recursive: true });`, 'recursiveRm'),
    bad(`${NS_FS}fs.renameSync(a, b);`, 'rename'),
    bad(`${DEFAULT_FS}fs.cpSync(a, b);`, 'cp'),
    bad(`${DEFAULT_FS}fs.copyFileSync(a, b);`, 'copyFile'),
    bad(`${DEFAULT_FS}fs.rmdirSync(a);`, 'rmdir'),
    bad(`${FSP_DEFAULT}await fsp.rm(d, { recursive: true });`, 'recursiveRm'),
    bad(`${FSP_DEFAULT}await fsp.rename(a, b);`, 'rename'),
    bad(`${DEFAULT_FS}await fs.promises.rename(a, b);`, 'rename'),
    bad(`${DEFAULT_FS}await fs.promises.rm(d, opts);`, 'recursiveRm'),
    bad(`${PROMISES_NAMED}await promises.cp(a, b);`, 'cp'),
    bad(`${PROMISES_ALIAS}await fsp.rmdir(a);`, 'rmdir'),
    bad(`${NS_FS}await fs.promises.copyFile(a, b);`, 'copyFile'),
    // Unprefixed module specifiers.
    bad("import { rmSync } from 'fs';\nrmSync(d, { recursive: true });", 'recursiveRm'),
    bad("import { rename } from 'fs/promises';\nawait rename(a, b);", 'rename'),
    // A banned function used as a VALUE is as banned as a call to it.
    bad(`${NAMED('rmSync')}names.map(rmSync);`, 'recursiveRm'),
    bad(`${NAMED('renameSync')}const f = renameSync;\nf(a, b);`, 'rename'),
    bad(`${DEFAULT_FS}names.map(fs.rmSync);`, 'recursiveRm'),
    bad(`${DEFAULT_FS}const f = fs.cpSync;`, 'cp'),
    bad(`${NAMED('copyFileSync')}export { copyFileSync };`, 'copyFile'),
    // Destructuring from a namespace.
    bad(`${DEFAULT_FS}const { rmSync } = fs;\nrmSync(d, { recursive: true });`, 'recursiveRm'),
    bad(`${DEFAULT_FS}const { rmSync } = fs;\nrmSync(d, opts);`, 'recursiveRm'),
    bad(`${DEFAULT_FS}const { renameSync: mv } = fs;\nmv(a, b);`, 'rename'),
    bad(`${DEFAULT_FS}const { promises: { rm } } = fs;\nawait rm(d, { recursive: true });`, 'recursiveRm'),
    bad(`${DEFAULT_FS}const fsp = fs.promises;\nawait fsp.rename(a, b);`, 'rename'),
    bad(`${DEFAULT_FS}const alias = fs;\nalias.cpSync(a, b);`, 'cp'),
    // Dynamic import and require.
    bad("const { rename } = await import('node:fs/promises');\nawait rename(a, b);", 'rename'),
    bad("const fs = await import('node:fs');\nfs.renameSync(a, b);", 'rename'),
    bad("const fs = require('node:fs');\nfs.rmSync(d, { recursive: true });", 'recursiveRm'),
    bad("const { cpSync } = require('fs');\ncpSync(a, b);", 'cp'),
    bad("(await import('node:fs/promises')).rename(a, b);", 'rename'),
    bad("require('node:fs').renameSync(a, b);", 'rename'),
    bad("const { promises } = require('node:fs');\nawait promises.rmdir(d);", 'rmdir'),
    // Computed member and indirect calls.
    bad(`${DEFAULT_FS}fs['renameSync'](a, b);`, 'rename'),
    bad(`${DEFAULT_FS}fs.renameSync.call(null, a, b);`, 'rename'),
    bad(`${DEFAULT_FS}fs.rmSync.apply(null, [d, { force: true }]);`, 'recursiveRm'),
    bad(`${NAMED('renameSync')}renameSync.bind(null, a);`, 'rename'),
    // Re-exports.
    bad("export { renameSync } from 'node:fs';", 'rename'),
    bad("export { rmSync as remove } from 'node:fs';", 'recursiveRm'),
    bad("export * from 'node:fs';", 'reexport'),
    // A spread before the options makes them unknown.
    bad(`${NAMED('rmSync')}rmSync(...args);`, 'recursiveRm'),
    bad(`${NAMED('rmSync')}rmSync(d, ...rest);`, 'recursiveRm'),
    // A bare DIRECTORY entry exempts that directory name in every package.
    {
      code: 'const a = 1;',
      filename: SRC_FILE,
      options: [{ exemptFiles: ['tree-change/'] }],
      errors: [{ messageId: 'unanchoredExemptDirectory' }],
    },
    // Two in one file are two reports.
    {
      code: `${NAMED('renameSync, cpSync')}renameSync(a, b);\ncpSync(a, b);`,
      filename: SRC_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'rename' }, { messageId: 'cp' }],
    },
    // Not exempt without the option: no default exemption ships.
    { code: `${NAMED('renameSync')}renameSync(a, b);`, filename: `${PRIMITIVE_DIR}apply.ts`, errors: [{ messageId: 'rename' }] },
    // DECOYS: the exempt directory's name under another root, and a same-named file.
    bad(`${NAMED('renameSync')}renameSync(a, b);`, 'rename', 'other/tree-change/x.ts'),
    bad(`${NAMED('renameSync')}renameSync(a, b);`, 'rename', 'packages/other/src/tree-change/x.ts'),
    bad(`${NAMED('renameSync')}renameSync(a, b);`, 'rename', 'packages/utils/src/tree-change-extras/x.ts'),
    bad(`${NAMED('cpSync')}cpSync(a, b);`, 'cp', 'packages/other/src/testing/fault-fs.ts'),
    bad(`${NAMED('rmSync')}rmSync(a, { recursive: true });`, 'recursiveRm', 'packages/other/src/test-helpers.ts'),
    // A file merely NAMED like a test is not one.
    bad(`${NAMED('rmSync')}rmSync(a, { recursive: true });`, 'recursiveRm', 'packages/cli/src/example.test.ts.bak'),
    // A bare-filename exemption is the repo-wide hole, reported as unanchored.
    {
      code: 'const a = 1;',
      filename: SRC_FILE,
      options: [{ exemptFiles: ['apply.ts'] }],
      errors: [{ messageId: 'unanchoredExemptFile' }],
    },
  ],
};

describe('no-destructive-fs', () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses('no-destructive-fs', CASES);
  });
});
