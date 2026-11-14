/**
 * `projection-sqlite-import-boundary` — every way a module can name the storage backend is an
 * import of it, a type included. The rule has no scope of its own: the config that enables it
 * says which files may import the backend. The VALID cases pin what only looks like the backend.
 */

import { describe, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses } from '../rule-tester.js';

const RULE = 'projection-sqlite-import-boundary';
const FILE = '/repo/packages/resources/src/projection/merge.ts';
const BACKEND = '@vibe-agent-toolkit/projection-sqlite';
const ERROR = [{ messageId: 'backendImport', data: { source: BACKEND } }];

const CASES: RuleCases = {
  valid: [
    { code: "import { populate } from '@vibe-agent-toolkit/resources';", filename: FILE },
    { code: "import { x } from '@vibe-agent-toolkit/projection-sqlite-extras';", filename: FILE },
    { code: "import { x } from './projection-sqlite.js';", filename: FILE },
    // Resolves to a sibling of the package, not into it.
    { code: "import { x } from '../../../projection-sqlite-extras/src/index.js';", filename: FILE },
    // Resolves inside resources, to a file merely named after the backend.
    { code: "import { x } from '../../projection/projection-sqlite.js';", filename: FILE },
    // The sibling's directory itself, bare: a prefix of the name is not the package.
    { code: "export const b: unknown = require('../../../projection-sqlite-extras');", filename: FILE },
    // A function another module calls `createRequire` is not node's.
    {
      code: `import { createRequire as cr } from './loader.js';\nexport const b: unknown = cr(import.meta.url)('${BACKEND}');`,
      filename: FILE,
    },
    { code: "export const name = '@vibe-agent-toolkit/projection-sqlite';", filename: FILE },
    { code: "declare function load(name: string): unknown;\nexport const x = load('@vibe-agent-toolkit/projection-sqlite');", filename: FILE },
  ],
  invalid: [
    { code: `import { openSqliteFactStore } from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `import type { RunDatabase } from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `import { type RunDatabase } from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `import * as Backend from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `import '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `export const load = () => import('${BACKEND}');`, filename: FILE, errors: ERROR },
    { code: `export type Handle = import('${BACKEND}').RunDatabase;`, filename: FILE, errors: ERROR },
    { code: `export { openRunDatabase } from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `export type { RunDatabase } from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `export * from '${BACKEND}';`, filename: FILE, errors: ERROR },
    { code: `export const backend: unknown = require('${BACKEND}');`, filename: FILE, errors: ERROR },
    { code: `import backend = require('${BACKEND}');\nexport const b = backend;`, filename: FILE, errors: ERROR },
    {
      code: `import { x } from '${BACKEND}/dist/store.js';`,
      filename: FILE,
      errors: [{ messageId: 'backendImport', data: { source: `${BACKEND}/dist/store.js` } }],
    },
    { code: 'export const load = () => import(`@vibe-agent-toolkit/projection-sqlite`);', filename: FILE, errors: ERROR },
    // A relative path into the backend's source is the backend, whatever it is called.
    {
      code: "import { openRunDatabase } from '../../../projection-sqlite/src/run-database.js';",
      filename: FILE,
      errors: [{ messageId: 'backendImport', data: { source: '../../../projection-sqlite/src/run-database.js' } }],
    },
    {
      code: "import { openRunDatabase } from '../../projection-sqlite/src/run-database.js';",
      filename: '/repo/packages/resources/src/merge.ts',
      errors: [{ messageId: 'backendImport', data: { source: '../../projection-sqlite/src/run-database.js' } }],
    },
    {
      code: "import type { RunDatabase } from '../../../projection-sqlite/src/index.js';",
      filename: FILE,
      errors: [{ messageId: 'backendImport', data: { source: '../../../projection-sqlite/src/index.js' } }],
    },
    // A Windows path to the file being linted resolves the same way.
    {
      code: "import { x } from '../../../projection-sqlite/src/index.js';",
      filename: String.raw`C:\repo\packages\resources\src\projection\merge.ts`,
      errors: [{ messageId: 'backendImport', data: { source: '../../../projection-sqlite/src/index.js' } }],
    },
    {
      code: `import { createRequire } from 'node:module';\nexport const b: unknown = createRequire(import.meta.url)('${BACKEND}');`,
      filename: FILE,
      errors: ERROR,
    },
    {
      code: `import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const b: unknown = load('${BACKEND}');`,
      filename: FILE,
      errors: ERROR,
    },
    { code: `declare module '${BACKEND}' {\n  export const x: number;\n}`, filename: FILE, errors: ERROR },
    // The package directory itself, bare or with a trailing slash, is the package.
    {
      code: "export const b: unknown = require('../../projection-sqlite');",
      filename: '/repo/packages/resources/src/merge.ts',
      errors: [{ messageId: 'backendImport', data: { source: '../../projection-sqlite' } }],
    },
    {
      code: "import backend from '../../../projection-sqlite/';\nexport const b = backend;",
      filename: FILE,
      errors: [{ messageId: 'backendImport', data: { source: '../../../projection-sqlite/' } }],
    },
    {
      code: "import { createRequire } from 'node:module';\nexport const b: unknown = createRequire(import.meta.url)('../../../projection-sqlite');",
      filename: FILE,
      errors: [{ messageId: 'backendImport', data: { source: '../../../projection-sqlite' } }],
    },
    // A call written above the binding it goes through.
    {
      code: `import { createRequire } from 'node:module';\nexport function b(): unknown {\n  return load('${BACKEND}');\n}\nconst load = createRequire(import.meta.url);`,
      filename: FILE,
      errors: ERROR,
    },
    // createRequire imported under another name, called directly and through a binding.
    {
      code: `import { createRequire as cr } from 'node:module';\nexport const b: unknown = cr(import.meta.url)('${BACKEND}');`,
      filename: FILE,
      errors: ERROR,
    },
    {
      code: `import { createRequire as cr } from 'node:module';\nconst load = cr(import.meta.url);\nexport const b: unknown = load('${BACKEND}');`,
      filename: FILE,
      errors: ERROR,
    },
    // A `.` segment is folded away, not counted as a directory a `..` climbs out of.
    {
      code: "export const b: unknown = require('./../../projection-sqlite');",
      filename: '/repo/packages/resources/src/merge.ts',
      errors: [{ messageId: 'backendImport', data: { source: './../../projection-sqlite' } }],
    },
    // `createRequire` by its own name with no import of it (a CommonJS destructure), and as a member.
    {
      code: `const { createRequire } = require('node:module');\nexport const b: unknown = createRequire(__filename)('${BACKEND}');`,
      filename: FILE,
      errors: ERROR,
    },
    {
      code: `import nodeModule from 'node:module';\nexport const b: unknown = nodeModule.createRequire(import.meta.url)('${BACKEND}');`,
      filename: FILE,
      errors: ERROR,
    },
    // A `..` past the root stays at the root, as real resolution does: the drive letter is kept,
    // so this resolves to C:/packages/projection-sqlite on Windows as it does on POSIX.
    {
      code: "import { x } from '../../packages/projection-sqlite/src/index.js';",
      filename: String.raw`C:\repo\merge.ts`,
      errors: [{ messageId: 'backendImport', data: { source: '../../packages/projection-sqlite/src/index.js' } }],
    },
    {
      code: "import { x } from '../../packages/projection-sqlite/src/index.js';",
      filename: '/repo/merge.ts',
      errors: [{ messageId: 'backendImport', data: { source: '../../packages/projection-sqlite/src/index.js' } }],
    },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
