import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  foreignLintInputs,
  LINT_SCRIPT,
  linterInputFindings,
  lintScriptFindings,
  renderPackageTurbo,
  renderTsconfigEslint,
  ROOT_LINT_EXTENSIONS,
  rootLintInputFindings,
  staleLintFiles,
} from '../src/generate-lint-config.js';

import { cleanupTestTempDir, createTestTempDir, writeFiles } from './test-helpers.js';

const NONE = (): boolean => false;

function manifest(dir: string, scripts: Record<string, string>): Record<string, string> {
  return { [`packages/${dir}/package.json`]: JSON.stringify({ name: `@scope/${dir}`, scripts }) };
}

/** A root turbo.json (with a comment, as turbo allows) declaring both lint tasks' inputs. */
function turbo(lint: string[], rootLint: string[]): string {
  return `// comment\n${JSON.stringify({ tasks: { lint: { inputs: lint }, '//#lint:root': { inputs: rootLint } } })}`;
}

describe('foreignLintInputs (the files the package program contains)', () => {
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

  const foreignOf = (isGlobal: (rel: string) => boolean = NONE): string[] => foreignLintInputs(root, 'a', isGlobal);

  it('follows an import in a file the program includes but ESLint ignores (a .d.ts, a *.config.ts)', () => {
    writeFiles(root, {
      'packages/a/src/types/ambient.d.ts': "import type { T } from '../../../b/src/from-dts.js';\nexport type U = T;\n",
      'packages/a/vitest.config.ts': "import { cfg } from '../b/src/from-config.js';\nexport default cfg;\n",
      'packages/b/src/from-dts.ts': 'export type T = string;\n',
      'packages/b/src/from-config.ts': 'export const cfg = {};\n',
    });
    expect(foreignOf()).toEqual(['packages/b/src/from-config.ts', 'packages/b/src/from-dts.ts']);
  });

  it('maps a .js specifier to a .d.ts', () => {
    writeFiles(root, {
      'packages/a/src/m.ts': "import type { M } from '../../b/lib/m.js';\nexport type N = M;\n",
      'packages/b/lib/m.d.ts': 'export type M = number;\n',
    });
    expect(foreignOf()).toEqual(['packages/b/lib/m.d.ts']);
  });

  it('follows the imports of a .d.ts it reaches', () => {
    writeFiles(root, {
      'packages/a/src/n.ts': '/// <reference path="../../b/lib2/n.d.ts" />\nexport const n = 1;\n',
      'packages/b/lib2/n.d.ts': "import type { O } from './o.js';\nexport type N = O;\n",
      'packages/b/lib2/o.ts': 'export type O = number;\n',
    });
    expect(foreignOf()).toEqual(['packages/b/lib2/n.d.ts', 'packages/b/lib2/o.ts']);
  });

  it('follows a no-substitution template import', () => {
    writeFiles(root, {
      'packages/a/src/t.ts': 'export const t = await import(`../../b/src/tpl.js`);\n',
      'packages/b/src/tpl.ts': 'export const tpl = 1;\n',
    });
    expect(foreignOf()).toEqual(['packages/b/src/tpl.ts']);
  });

  it('follows a reference path with no ./ prefix', () => {
    writeFiles(root, {
      'packages/a/src/r.ts': '/// <reference path="generated/local.d.ts" />\nexport const r = 1;\n',
      'packages/a/src/generated/local.d.ts': "import type { V } from '../../../b/src/via-ref.js';\nexport type W = V;\n",
      'packages/b/src/via-ref.ts': 'export type V = number;\n',
    });
    expect(foreignOf()).toEqual(['packages/b/src/via-ref.ts']);
  });

  it("follows a bare '..' specifier", () => {
    writeFiles(root, {
      'packages/a/bare.cts': "import p = require('..');\nexport = p;\n",
      'packages/index.ts': 'export const top = 1;\n',
    });
    expect(foreignOf()).toEqual(['packages/index.ts']);
  });

  it("follows a global dependency's own imports, listing only what it reaches", () => {
    writeFiles(root, {
      'packages/a/src/g.ts': "import { shared } from '../../../shared.js';\nexport const g = shared;\n",
      'shared.ts': "export { c as shared } from './packages/c/src/c.js';\n",
      'packages/c/src/c.ts': 'export const c = 1;\n',
    });
    expect(foreignOf((rel) => rel === 'shared.ts')).toEqual(['packages/c/src/c.ts']);
  });

  it('lists nothing for a package that imports only itself, node_modules and dist', () => {
    writeFiles(root, {
      'packages/a/src/i.ts': "import { own } from './own.js';\nimport type { D } from '../../b/dist/index.js';\nexport const i: D = own;\n",
      'packages/b/dist/index.d.ts': 'export type D = number;\n',
    });
    expect(foreignOf()).toEqual([]);
  });
});

describe('renderPackageTurbo', () => {
  it('adds a lint entry extending the root inputs, keeping every other task', () => {
    const current = JSON.stringify({ extends: ['//'], tasks: { 'test:integration': { cache: true } } });
    const rendered = JSON.parse(renderPackageTurbo(current, ['packages/b/x.ts']) ?? 'null') as { tasks: Record<string, unknown> };
    expect(rendered.tasks).toEqual({ 'test:integration': { cache: true }, lint: { inputs: ['$TURBO_EXTENDS$', '$TURBO_ROOT$/packages/b/x.ts'] } });
  });

  it('reads a package turbo.json with comments, as turbo does', () => {
    const current = `// owned by hand\n${JSON.stringify({ extends: ['//'], tasks: { build: { cache: true } } })}`;
    expect(JSON.parse(renderPackageTurbo(current, []) ?? 'null')).toEqual({ extends: ['//'], tasks: { build: { cache: true } } });
  });

  it('keeps a file whose only other content is not a task', () => {
    const current = JSON.stringify({ extends: ['//'], tags: ['leaf'], tasks: { lint: { inputs: ['$TURBO_EXTENDS$'] } } });
    expect(JSON.parse(renderPackageTurbo(current, []) ?? 'null')).toEqual({ extends: ['//'], tags: ['leaf'] });
  });

  it('removes the lint entry when nothing is foreign, and the file when no task is left', () => {
    const onlyLint = JSON.stringify({ extends: ['//'], tasks: { lint: { inputs: ['$TURBO_EXTENDS$'] } } });
    expect(renderPackageTurbo(onlyLint, [])).toBeNull();
    expect(renderPackageTurbo(undefined, [])).toBeNull();
    const withOther = JSON.stringify({ extends: ['//'], tasks: { lint: {}, build: { cache: true } } });
    expect(JSON.parse(renderPackageTurbo(withOther, []) ?? 'null')).toEqual({ extends: ['//'], tasks: { build: { cache: true } } });
  });
});

describe('staleLintFiles', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('names each generated file that differs from what the generator writes, with the text it should hold', () => {
    writeFiles(root, {
      'packages/fresh/tsconfig.eslint.json': renderTsconfigEslint(),
      'packages/edited/tsconfig.eslint.json': '{}\n',
      'packages/jsonly/tsconfig.eslint.json': renderTsconfigEslint(),
      'packages/leftover/turbo.json': JSON.stringify({ extends: ['//'], tasks: { lint: { inputs: ['$TURBO_EXTENDS$', '$TURBO_ROOT$/gone.ts'] } } }),
    });
    const plans = [
      { dir: 'fresh', lintable: ['packages/fresh/src/a.ts'], foreign: [] },
      { dir: 'edited', lintable: ['packages/edited/src/a.ts'], foreign: [] },
      { dir: 'jsonly', lintable: ['packages/jsonly/index.js'], foreign: [] },
      { dir: 'importer', lintable: [], foreign: ['packages/b/x.ts'] },
      { dir: 'leftover', lintable: [], foreign: [] },
    ];
    expect(staleLintFiles(root, plans)).toEqual([
      { relPath: 'packages/edited/tsconfig.eslint.json', expected: renderTsconfigEslint() },
      { relPath: 'packages/jsonly/tsconfig.eslint.json', expected: null },
      { relPath: 'packages/importer/turbo.json', expected: renderPackageTurbo(undefined, ['packages/b/x.ts']) },
      { relPath: 'packages/leftover/turbo.json', expected: null },
    ]);
  });
});

describe('rootLintInputFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('wants one prefixed glob per place holding a root-linted file, no more and no fewer', () => {
    writeFiles(root, { 'turbo.json': turbo([], [`*.${ROOT_LINT_EXTENSIONS}`, `old/**/*.${ROOT_LINT_EXTENSIONS}`, 'package.json']) });
    expect(rootLintInputFindings(root, ['eslint.config.js', 'tools/a/run.ts']).map((f) => f.message)).toEqual([
      expect.stringMatching(/lints files that "tools\/\*\*\/\*\.\{js,.*add it/),
      expect.stringMatching(/input "old\/\*\*\/\*\.\{js,.*matches no file it lints/),
    ]);
    expect(rootLintInputFindings(root, ['eslint.config.js', 'old/x.js'])).toEqual([]);
  });
});

describe('lintScriptFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('requires the one lint script where ESLint lints a file and forbids one where it lints none', () => {
    writeFiles(root, {
      'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
      ...manifest('good', { lint: LINT_SCRIPT }),
      ...manifest('missing', {}),
      ...manifest('variant', { lint: 'eslint . --cache' }),
      ...manifest('empty', { lint: LINT_SCRIPT }),
      ...manifest('umbrella', {}),
    });
    const plans = [
      { dir: 'good', lintable: ['packages/good/src/a.ts'], foreign: [] },
      { dir: 'missing', lintable: ['packages/missing/test/a.test.ts'], foreign: [] },
      { dir: 'variant', lintable: ['packages/variant/eslint/r.cjs'], foreign: [] },
      { dir: 'empty', lintable: [], foreign: [] },
      { dir: 'umbrella', lintable: [], foreign: [] },
    ];
    expect(lintScriptFindings(root, plans).map((f) => `${f.path}: ${f.message}`)).toEqual([
      expect.stringMatching(/^packages\/missing\/package\.json: `lint` must be exactly "VAT_LINT_TASK=1 eslint \. --max-warnings=0"; found undefined/),
      expect.stringMatching(/^packages\/variant\/package\.json: `lint` must be exactly .*found "eslint \. --cache"/),
      expect.stringMatching(/^packages\/empty\/package\.json: `lint` is declared but ESLint lints no file/),
    ]);
  });
});

describe('linterInputFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  const CONFIG = "import a from 'eslint-plugin-a';\nimport b from '@scope/eslint-plugin-b/sub';\nimport fs from 'node:fs';\nimport local from './local.cjs';\n// require('not-imported')\n";

  it('accepts inputs naming exactly the imported packages plus eslint and typescript', () => {
    const names = ['@scope/eslint-plugin-b', 'eslint', 'eslint-plugin-a', 'typescript'];
    writeFiles(root, {
      'eslint.config.js': CONFIG,
      'turbo.json': turbo(
        ['$TURBO_DEFAULT$', ...names.map((n) => `$TURBO_ROOT$/node_modules/${n}/package.json`), '$TURBO_ROOT$/node_modules/.bun/x+*/node_modules/x/*/package.json'],
        names.map((n) => `node_modules/${n}/package.json`),
      ),
    });
    expect(linterInputFindings(root)).toEqual([]);
  });

  it('flags a missing package and one the config does not import, per task', () => {
    writeFiles(root, {
      'eslint.config.js': CONFIG,
      'turbo.json': turbo(
        ['eslint', 'eslint-plugin-a', 'typescript', 'stale-plugin'].map((n) => `$TURBO_ROOT$/node_modules/${n}/package.json`),
        ['@scope/eslint-plugin-b', 'eslint', 'eslint-plugin-a', 'typescript'].map((n) => `node_modules/${n}/package.json`),
      ),
    });
    expect(linterInputFindings(root).map((f) => f.message)).toEqual([
      expect.stringMatching(/"lint" task.*Missing: @scope\/eslint-plugin-b\. Not imported: stale-plugin\./),
    ]);
  });
});
