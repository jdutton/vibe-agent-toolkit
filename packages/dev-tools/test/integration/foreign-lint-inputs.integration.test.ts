/**
 * foreignLintInputs builds a real TypeScript program from a package's tsconfig.eslint.json, so it
 * lives in the integration tier. One parse cache spans every case, as planLintConfig shares one
 * across packages: the lib declarations are parsed once, not once per case.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foreignLintInputs, renderTsconfigEslint, type SourceFileCache } from '../../src/generate-lint-config.js';
import { cleanupTestTempDir, createTestTempDir, writeFiles } from '../test-helpers.js';

interface FormCase {
  name: string;
  files: Record<string, string>;
  expected: string[];
  isGlobal?: (rel: string) => boolean;
}

const CASES: FormCase[] = [
  {
    name: 'follows an import in a file the program includes but ESLint ignores (a .d.ts, a *.config.ts)',
    files: {
      'packages/a/src/types/ambient.d.ts': "import type { T } from '../../../b/src/from-dts.js';\nexport type U = T;\n",
      'packages/a/vitest.config.ts': "import { cfg } from '../b/src/from-config.js';\nexport default cfg;\n",
      'packages/b/src/from-dts.ts': 'export type T = string;\n',
      'packages/b/src/from-config.ts': 'export const cfg = {};\n',
    },
    expected: ['packages/b/src/from-config.ts', 'packages/b/src/from-dts.ts'],
  },
  {
    name: 'maps a .js specifier to a .d.ts',
    files: {
      'packages/a/src/m.ts': "import type { M } from '../../b/lib/m.js';\nexport type N = M;\n",
      'packages/b/lib/m.d.ts': 'export type M = number;\n',
    },
    expected: ['packages/b/lib/m.d.ts'],
  },
  {
    name: 'follows the imports of a .d.ts it reaches',
    files: {
      'packages/a/src/n.ts': '/// <reference path="../../b/lib2/n.d.ts" />\nexport const n = 1;\n',
      'packages/b/lib2/n.d.ts': "import type { O } from './o.js';\nexport type N = O;\n",
      'packages/b/lib2/o.ts': 'export type O = number;\n',
    },
    expected: ['packages/b/lib2/n.d.ts', 'packages/b/lib2/o.ts'],
  },
  {
    name: 'follows a no-substitution template import',
    files: {
      'packages/a/src/t.ts': 'export const t = await import(`../../b/src/tpl.js`);\n',
      'packages/b/src/tpl.ts': 'export const tpl = 1;\n',
    },
    expected: ['packages/b/src/tpl.ts'],
  },
  {
    name: 'follows a reference path with no ./ prefix',
    files: {
      'packages/a/src/r.ts': '/// <reference path="generated/local.d.ts" />\nexport const r = 1;\n',
      'packages/a/src/generated/local.d.ts': "import type { V } from '../../../b/src/via-ref.js';\nexport type W = V;\n",
      'packages/b/src/via-ref.ts': 'export type V = number;\n',
    },
    expected: ['packages/b/src/via-ref.ts'],
  },
  {
    name: "follows a bare '..' specifier",
    files: {
      'packages/a/bare.cts': "import p = require('..');\nexport = p;\n",
      'packages/index.ts': 'export const top = 1;\n',
    },
    expected: ['packages/index.ts'],
  },
  {
    name: "follows a global dependency's own imports, listing only what it reaches",
    files: {
      'packages/a/src/g.ts': "import { shared } from '../../../shared.js';\nexport const g = shared;\n",
      'shared.ts': "export { c as shared } from './packages/c/src/c.js';\n",
      'packages/c/src/c.ts': 'export const c = 1;\n',
    },
    expected: ['packages/c/src/c.ts'],
    isGlobal: (rel) => rel === 'shared.ts',
  },
  {
    name: 'lists nothing for a package that imports only itself, node_modules and dist',
    files: {
      'packages/a/src/i.ts': "import { own } from './own.js';\nimport type { D } from '../../b/dist/index.js';\nexport const i: D = own;\n",
      'packages/b/dist/index.d.ts': 'export type D = number;\n',
    },
    expected: [],
  },
];

describe('foreignLintInputs (the files the package program contains)', () => {
  const cache: SourceFileCache = new Map();
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
    writeFiles(root, {
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: [] } }),
      'packages/a/package.json': JSON.stringify({ name: 'a', type: 'module' }),
      'packages/a/tsconfig.eslint.json': renderTsconfigEslint(),
      'packages/a/src/own.ts': 'export const own = 1;\n',
      'packages/b/package.json': JSON.stringify({ name: 'b', type: 'module' }),
      'packages/c/package.json': JSON.stringify({ name: 'c', type: 'module' }),
    });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it.each(CASES)('$name', ({ files, expected, isGlobal }) => {
    writeFiles(root, files);
    expect(foreignLintInputs(root, 'a', isGlobal ?? ((): boolean => false), cache)).toEqual(expected);
  });
});
