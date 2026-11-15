/**
 * `no-link-following-fs` — product source may not ask the kernel to FOLLOW a link (`stat`,
 * `statSync`, `existsSync`, `realpath*`) except in the one guarded module, which reads the link
 * chain by its text first: a Windows kernel asked to follow a link to `\\host\share` offers the
 * operator's NTLM credentials to that host before any answer comes back. The VALID cases pin the
 * scope and the decoys a name match alone would catch (`lstat` follows nothing; a file handle's
 * `stat()` acts on what is already open); the INVALID ones pin every way each function is reached.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'no-link-following-fs';
const SRC = '/repo/packages/cli/src/commands/build.ts';
const TEST_FILE = '/repo/packages/cli/test/commands/build.test.ts';
const OUTSIDE = '/repo/scripts/release.ts';
const ALLOWED = 'packages/utils/src/link-following.ts';
const ERR = [{ messageId: 'follows' }] as const;
const UNTYPED = [{ messageId: 'untypedLink' }] as const;

const CASES: RuleCases = {
  valid: [
    { code: "import { statSync } from 'node:fs'; statSync(p);", filename: TEST_FILE },
    { code: "import { statSync } from 'node:fs'; statSync(p);", filename: OUTSIDE },
    // The replacements, and what follows nothing.
    { code: "import { followedStatSync } from '@vibe-agent-toolkit/utils'; followedStatSync(p, root);", filename: SRC },
    { code: "import { lstatSync } from 'node:fs'; import { lstat } from 'node:fs/promises'; lstatSync(p); await lstat(p);", filename: SRC },
    { code: "import fs from 'node:fs/promises'; const h = await fs.open(p); await h.stat();", filename: SRC },
    { code: "import { fstatSync } from 'node:fs'; fstatSync(fd);", filename: SRC },
    // Decoys: same names that are not the fs module's.
    { code: "import { stat } from './my-fs.js'; stat(p);", filename: SRC },
    { code: 'const stat = (p: string) => p; stat(p); store.realpath(p);', filename: SRC },
    { code: "import type { Stats } from 'node:fs';", filename: SRC },
    // The allowlist, by full repo-relative path.
    { code: "import { statSync } from 'node:fs'; statSync(p);", filename: `/repo/${ALLOWED}`, options: [{ allowFiles: [ALLOWED] }] },
    // A link made with its type named: Node asks the kernel nothing about the target.
    { code: "import fs from 'node:fs/promises'; await fs.symlink(t, p, 'dir');", filename: SRC },
    { code: "import { symlinkSync } from 'node:fs'; symlinkSync(t, p, isWindows ? 'junction' : 'dir');", filename: SRC },
    { code: "import { symlink } from 'node:fs/promises'; await symlink(t, p, type);", filename: SRC },
    { code: "import fs from 'node:fs'; fs.symlink(t, p, 'file', (error) => done(error));", filename: SRC },
  ],
  invalid: [
    { code: "import { statSync } from 'node:fs'; statSync(p);", filename: SRC, errors: ERR },
    { code: "import { existsSync } from 'fs'; existsSync(p);", filename: SRC, errors: ERR },
    { code: "import { realpathSync } from 'node:fs'; realpathSync.native(p);", filename: SRC, errors: ERR },
    { code: "import { realpath } from 'node:fs'; realpath(p, cb);", filename: SRC, errors: ERR },
    { code: "import { stat } from 'node:fs/promises'; await stat(p);", filename: SRC, errors: ERR },
    { code: "import { realpath as rp } from 'fs/promises'; await rp(p);", filename: SRC, errors: ERR },
    { code: "import fs from 'node:fs/promises'; await fs.stat(p);", filename: SRC, errors: ERR },
    { code: "import * as fs from 'node:fs'; fs.statSync(p);", filename: SRC, errors: ERR },
    { code: "import fs from 'node:fs'; await fs.promises.stat(p);", filename: SRC, errors: ERR },
    { code: "import { promises } from 'node:fs'; await promises.realpath(p);", filename: SRC, errors: ERR },
    { code: "import { promises as fsp } from 'node:fs'; await fsp.stat(p);", filename: SRC, errors: ERR },
    { code: "const { stat } = require('node:fs/promises'); stat(p);", filename: SRC, errors: ERR },
    { code: "require('node:fs').realpathSync(p);", filename: SRC, errors: ERR },
    { code: "export { statSync } from 'node:fs';", filename: SRC, errors: ERR },
    { code: "import { statSync } from 'node:fs'; paths.map(statSync);", filename: SRC, errors: ERR },
    // The allowlist names ONE file.
    { code: "import { statSync } from 'node:fs'; statSync(p);", filename: SRC, options: [{ allowFiles: [ALLOWED] }], errors: ERR },
    // A link made with NO type: on Windows Node follows the target to pick one.
    { code: "import fs from 'node:fs/promises'; await fs.symlink(t, p);", filename: SRC, errors: UNTYPED },
    { code: "import { symlinkSync } from 'node:fs'; symlinkSync(t, p);", filename: SRC, errors: UNTYPED },
    { code: "import { symlink as ln } from 'fs/promises'; await ln(t, p, undefined);", filename: SRC, errors: UNTYPED },
    { code: "import fs from 'node:fs'; await fs.promises.symlink(t, p, null);", filename: SRC, errors: UNTYPED },
    { code: "import fs from 'node:fs'; fs.symlink(t, p, (error) => done(error));", filename: SRC, errors: UNTYPED },
    { code: "const { symlinkSync } = require('node:fs'); symlinkSync(t, p);", filename: SRC, errors: UNTYPED },
    // Handed on, its arguments are not this call's to see.
    { code: "import { symlink } from 'node:fs/promises'; await pairs.map(([t, p]) => p).forEach(symlink);", filename: SRC, errors: UNTYPED },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
