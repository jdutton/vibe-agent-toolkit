/**
 * `commands-import-boundary` — a command module may not reach the filesystem
 * or a package's internals directly. The VALID cases pin the seams a command
 * IS allowed to use (the utils/resources barrels, the crawl lane, type-only
 * imports) and the scoping (a file outside `commandGlobs` is never checked);
 * the INVALID ones pin every import shape a boundary rule can go blind to.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'commands-import-boundary';
const COMMAND = '/repo/packages/cli/src/commands/audit.ts';
const NESTED_COMMAND = '/repo/packages/cli/src/commands/claude/org/skills.ts';
const NOT_COMMAND = '/repo/packages/cli/src/utils/resource-loader.ts';
const RATCHET = 'packages/cli/src/commands/audit.ts';
const FS_IMPORT = "import { readdirSync } from 'node:fs';";
const CUSTOM_SCOPE = [{ commandGlobs: ['packages/lab/src/verbs/**'] }];
const WITH_RATCHET = [{ allowFiles: [RATCHET] }];
const WALKERS = [{ forbiddenModules: ['^@vibe-agent-toolkit/resources/', String.raw`(^|/)file-walker\.js$`] }];

const CASES: RuleCases = {
  valid: [
    // The seams a command goes through.
    { code: "import { buildResourceProjection } from '@vibe-agent-toolkit/resources';", filename: COMMAND },
    { code: "import { crawlDirectory } from '@vibe-agent-toolkit/utils/crawl';", filename: COMMAND },
    { code: "import { safePath } from '@vibe-agent-toolkit/utils';", filename: COMMAND },
    { code: "import { loadConfig } from '../utils/config-loader.js';", filename: COMMAND },
    // Types do no I/O.
    { code: "import type { Dirent } from 'node:fs';", filename: COMMAND },
    { code: "import type { Stats } from 'fs';", filename: COMMAND },
    // Outside the command directory the rule is silent.
    { code: FS_IMPORT, filename: NOT_COMMAND },
    { code: "import { walk } from '@vibe-agent-toolkit/resources/src/walk.js';", filename: NOT_COMMAND, options: WALKERS },
    // A command directory elsewhere is only a command directory if configured.
    { code: FS_IMPORT, filename: '/repo/packages/lab/src/verbs/run.ts' },
    { code: FS_IMPORT, filename: COMMAND, options: CUSTOM_SCOPE },
    // The ratchet: today's offender, by full repo-relative path.
    { code: FS_IMPORT, filename: `/repo/${RATCHET}`, options: WITH_RATCHET },
    // A forbidden-module pattern only bites what it matches.
    { code: "import { x } from './helpers/file-walker-config.js';", filename: COMMAND, options: WALKERS },
  ],
  invalid: [
    { code: FS_IMPORT, filename: COMMAND, errors: [{ messageId: 'fsImport', data: { source: 'node:fs' } }] },
    { code: "import { readdir } from 'node:fs/promises';", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    { code: "import { readdirSync } from 'fs';", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    { code: "import { readdir } from 'fs/promises';", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    { code: "import * as fs from 'node:fs';", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    { code: "import fs from 'node:fs';", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    // Nested command directories are still command directories.
    { code: FS_IMPORT, filename: NESTED_COMMAND, errors: [{ messageId: 'fsImport' }] },
    // Windows separators.
    { code: FS_IMPORT, filename: String.raw`C:\repo\packages\cli\src\commands\audit.ts`, errors: [{ messageId: 'fsImport' }] },
    // Dynamic import and require with a literal source are imports too.
    { code: "const fs = await import('node:fs');", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    { code: "const fs = require('node:fs');", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    // Re-exporting is importing.
    { code: "export { readdirSync } from 'node:fs';", filename: COMMAND, errors: [{ messageId: 'fsImport' }] },
    // The default forbidden pattern: a resources subpath is an internal.
    {
      code: "import { walk } from '@vibe-agent-toolkit/resources/src/projection/walk.js';",
      filename: COMMAND,
      errors: [{ messageId: 'forbiddenModule', data: { source: '@vibe-agent-toolkit/resources/src/projection/walk.js', pattern: '^@vibe-agent-toolkit/resources/' } }],
    },
    // A configured local walker module.
    { code: "import { walkTree } from '../utils/file-walker.js';", filename: COMMAND, options: WALKERS, errors: [{ messageId: 'forbiddenModule' }] },
    // The ratchet names ONE file; a sibling in the same directory is not it.
    { code: FS_IMPORT, filename: '/repo/packages/cli/src/commands/build.ts', options: WITH_RATCHET, errors: [{ messageId: 'fsImport' }] },
    // A custom scope is enforced where it points.
    { code: FS_IMPORT, filename: '/repo/packages/lab/src/verbs/run.ts', options: CUSTOM_SCOPE, errors: [{ messageId: 'fsImport' }] },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
