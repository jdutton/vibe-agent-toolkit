import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  foreignLintInputs,
  LINT_SCRIPT,
  linterInputFindings,
  lintScriptFindings,
  relativeSpecifiers,
  renderPackageTurbo,
  resolveRelativeSpecifier,
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

describe('relativeSpecifiers', () => {
  it('reads every import form from the syntax tree and nothing from comments or strings', () => {
    const text = [
      '/// <reference path="./h.d.ts" />',
      "import a from './a.js';",
      "export { b } from '../b.js';",
      "import type { C } from './c.js';",
      "const d = await import('./d.js');",
      "const e = require('./e.cjs');",
      "import f = require('./f.js');",
      "type G = import('./g.js').G;",
      "import pkg from '@scope/pkg';",
      "// import x from './in-a-comment.js'; require('./also-comment.js')",
      "const s = `import y from './in-a-template.js'`;",
      "const t = \"require('./in-a-string.js')\";",
    ].join('\n');
    expect(relativeSpecifiers(text).sort((x, y) => x.localeCompare(y))).toEqual(
      ['../b.js', './a.js', './c.js', './d.js', './e.cjs', './f.js', './g.js', './h.d.ts'],
    );
  });
});

describe('foreignLintInputs', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('follows relative imports out of the package and transitively through what they import', () => {
    writeFiles(root, {
      'packages/a/test/x.test.ts': "import { help } from '../../b/test/helpers.js';\nimport { own } from '../src/own.js';",
      'packages/a/src/own.ts': "import { deep } from '../../c/src/deep.js';",
      'packages/b/test/helpers.ts': "import { more } from '../src/more/index.js';",
      'packages/b/src/more/index.ts': "export const more = 1;\nimport { cfg } from '../../../../shared.js';",
      'packages/c/src/deep.ts': "import dep from '../node_modules/x/index.js';",
      'packages/c/node_modules/x/index.ts': '',
      'shared.ts': '',
    });
    const isGlobal = (rel: string): boolean => rel === 'shared.ts';
    expect(foreignLintInputs(root, 'a', ['packages/a/test/x.test.ts', 'packages/a/src/own.ts'], isGlobal)).toEqual([
      'packages/b/src/more/index.ts',
      'packages/b/test/helpers.ts',
      'packages/c/src/deep.ts',
    ]);
  });

  it('lists nothing for a package that imports only itself and packages by name', () => {
    writeFiles(root, { 'packages/a/src/i.ts': "import { x } from './x.js';\nimport { u } from '@scope/b';", 'packages/a/src/x.ts': '' });
    expect(foreignLintInputs(root, 'a', ['packages/a/src/i.ts'], NONE)).toEqual([]);
  });

  it('resolves a .js specifier to its .ts source and a directory to its index', () => {
    writeFiles(root, { 'p/a.ts': '', 'p/dir/index.ts': '', 'p/c.cts': '' });
    expect(resolveRelativeSpecifier(safePath.join(root, 'p/from.ts'), './a.js', root)).toBe(safePath.join(root, 'p/a.ts'));
    expect(resolveRelativeSpecifier(safePath.join(root, 'p/from.ts'), './dir', root)).toBe(safePath.join(root, 'p/dir/index.ts'));
    expect(resolveRelativeSpecifier(safePath.join(root, 'p/from.ts'), './c.cjs', root)).toBe(safePath.join(root, 'p/c.cts'));
    expect(resolveRelativeSpecifier(safePath.join(root, 'p/from.ts'), './missing.js', root)).toBeUndefined();
  });
});

describe('renderPackageTurbo', () => {
  it('adds a lint entry extending the root inputs, keeping every other task', () => {
    const current = JSON.stringify({ extends: ['//'], tasks: { 'test:integration': { cache: true } } });
    const rendered = JSON.parse(renderPackageTurbo(current, ['packages/b/x.ts']) ?? 'null') as { tasks: Record<string, unknown> };
    expect(rendered.tasks).toEqual({ 'test:integration': { cache: true }, lint: { inputs: ['$TURBO_EXTENDS$', '$TURBO_ROOT$/packages/b/x.ts'] } });
  });

  it('removes the lint entry when nothing is foreign, and the file when no task is left', () => {
    const onlyLint = JSON.stringify({ extends: ['//'], tasks: { lint: { inputs: ['$TURBO_EXTENDS$'] } } });
    expect(renderPackageTurbo(onlyLint, [])).toBeNull();
    expect(renderPackageTurbo(undefined, [])).toBeNull();
    const withOther = JSON.stringify({ extends: ['//'], tasks: { lint: {}, build: { cache: true } } });
    expect(JSON.parse(renderPackageTurbo(withOther, []) ?? 'null')).toEqual({ extends: ['//'], tasks: { build: { cache: true } } });
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
