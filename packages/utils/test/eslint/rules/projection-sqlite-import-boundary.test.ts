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
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });
});
