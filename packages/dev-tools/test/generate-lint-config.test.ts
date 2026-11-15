import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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

/** A fresh temp directory per test, removed after it: the getter reads the current one. */
function useTempRoot(): () => string {
  let root = '';
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });
  return () => root;
}

function manifest(dir: string, scripts: Record<string, string>): Record<string, string> {
  return { [`packages/${dir}/package.json`]: JSON.stringify({ name: `@scope/${dir}`, scripts }) };
}

/** A root turbo.json (with a comment, as turbo allows) declaring both lint tasks' inputs. */
function turbo(lint: string[], rootLint: string[]): string {
  return `// comment\n${JSON.stringify({ tasks: { lint: { inputs: lint }, '//#lint:root': { inputs: rootLint } } })}`;
}

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
  const tempRoot = useTempRoot();

  it('names each generated file that differs from what the generator writes, with the text it should hold', () => {
    writeFiles(tempRoot(), {
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
    expect(staleLintFiles(tempRoot(), plans)).toEqual([
      { relPath: 'packages/edited/tsconfig.eslint.json', expected: renderTsconfigEslint() },
      { relPath: 'packages/jsonly/tsconfig.eslint.json', expected: null },
      { relPath: 'packages/importer/turbo.json', expected: renderPackageTurbo(undefined, ['packages/b/x.ts']) },
      { relPath: 'packages/leftover/turbo.json', expected: null },
    ]);
  });
});

describe('rootLintInputFindings', () => {
  const tempRoot = useTempRoot();

  it('wants one prefixed glob per place holding a root-linted file, no more and no fewer', () => {
    writeFiles(tempRoot(), { 'turbo.json': turbo([], [`*.${ROOT_LINT_EXTENSIONS}`, `old/**/*.${ROOT_LINT_EXTENSIONS}`, 'package.json']) });
    expect(rootLintInputFindings(tempRoot(), ['eslint.config.js', 'tools/a/run.ts']).map((f) => f.message)).toEqual([
      expect.stringMatching(/lints files that "tools\/\*\*\/\*\.\{js,.*add it/),
      expect.stringMatching(/input "old\/\*\*\/\*\.\{js,.*matches no file it lints/),
    ]);
    expect(rootLintInputFindings(tempRoot(), ['eslint.config.js', 'old/x.js'])).toEqual([]);
  });
});

describe('lintScriptFindings', () => {
  const tempRoot = useTempRoot();

  it('requires the one lint script where ESLint lints a file and forbids one where it lints none', () => {
    writeFiles(tempRoot(), {
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
    expect(lintScriptFindings(tempRoot(), plans).map((f) => `${f.path}: ${f.message}`)).toEqual([
      expect.stringMatching(/^packages\/missing\/package\.json: `lint` must be exactly "VAT_LINT_TASK=1 eslint \. --max-warnings=0"; found undefined/),
      expect.stringMatching(/^packages\/variant\/package\.json: `lint` must be exactly .*found "eslint \. --cache"/),
      expect.stringMatching(/^packages\/empty\/package\.json: `lint` is declared but ESLint lints no file/),
    ]);
  });
});

describe('linterInputFindings', () => {
  const tempRoot = useTempRoot();

  const CONFIG = "import a from 'eslint-plugin-a';\nimport b from '@scope/eslint-plugin-b/sub';\nimport fs from 'node:fs';\nimport local from './local.cjs';\n// require('not-imported')\n";

  it('accepts inputs naming exactly the imported packages plus eslint and typescript', () => {
    const names = ['@scope/eslint-plugin-b', 'eslint', 'eslint-plugin-a', 'typescript'];
    writeFiles(tempRoot(), {
      'eslint.config.js': CONFIG,
      'turbo.json': turbo(
        ['$TURBO_DEFAULT$', ...names.map((n) => `$TURBO_ROOT$/node_modules/${n}/package.json`), '$TURBO_ROOT$/node_modules/.bun/x+*/node_modules/x/*/package.json'],
        names.map((n) => `node_modules/${n}/package.json`),
      ),
    });
    expect(linterInputFindings(tempRoot())).toEqual([]);
  });

  it('flags a missing package and one the config does not import, per task', () => {
    writeFiles(tempRoot(), {
      'eslint.config.js': CONFIG,
      'turbo.json': turbo(
        ['eslint', 'eslint-plugin-a', 'typescript', 'stale-plugin'].map((n) => `$TURBO_ROOT$/node_modules/${n}/package.json`),
        ['@scope/eslint-plugin-b', 'eslint', 'eslint-plugin-a', 'typescript'].map((n) => `node_modules/${n}/package.json`),
      ),
    });
    expect(linterInputFindings(tempRoot()).map((f) => f.message)).toEqual([
      expect.stringMatching(/"lint" task.*Missing: @scope\/eslint-plugin-b\. Not imported: stale-plugin\./),
    ]);
  });
});
