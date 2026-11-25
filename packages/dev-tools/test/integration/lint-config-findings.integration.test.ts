/**
 * The lint-config checks that read a repository (its ignore files, its git listing, ESLint's view of
 * it), each run on a fixture repository built to trip it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectLintConfigFindings,
  gitignoredLintFindings,
  ignoreFileFindings,
  LINT_SCRIPT,
  renderTsconfigEslint,
  ROOT_LINT_EXTENSIONS,
  TYPECHECK_SCRIPT,
} from '../../src/generate-lint-config.js';
import { cleanupTestTempDir, commitAllAsRepo, createTestTempDir, writeFiles } from '../test-helpers.js';

/** A root turbo.json whose two lint tasks carry `lint` and `rootLint` as inputs. */
function turboWith(lint: readonly string[], rootLint: readonly string[]): string {
  const typecheck = lint.filter((input) => input === '$TURBO_DEFAULT$' || input.endsWith('node_modules/typescript/package.json'));
  return JSON.stringify({ tasks: { lint: { inputs: lint }, typecheck: { inputs: typecheck }, '//#lint:root': { inputs: rootLint } } });
}

/** A repository whose lint wiring is right in every respect the checks read. */
function writeCleanRepo(root: string): void {
  const linterInputs = ['eslint', 'typescript'];
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }),
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] } }),
    '.gitignore': 'node_modules/\n',
    'eslint-config-support.js': "export const IGNORE_FILES = ['.gitignore'];\n",
    'eslint.config.js': "import './eslint-config-support.js';\nexport default [{ files: ['**/*.ts', '**/*.js'] }];\n",
    'turbo.json': turboWith(
      ['$TURBO_DEFAULT$', '$TURBO_ROOT$/eslint-config-support.js', '$TURBO_ROOT$/.gitignore', ...linterInputs.map((n) => `$TURBO_ROOT$/node_modules/${n}/package.json`)],
      [`*.${ROOT_LINT_EXTENSIONS}`, '.gitignore', ...linterInputs.map((n) => `node_modules/${n}/package.json`)],
    ),
    'packages/a/package.json': JSON.stringify({ name: 'a', type: 'module', scripts: { lint: LINT_SCRIPT, typecheck: TYPECHECK_SCRIPT } }),
    'packages/a/src/x.ts': 'export const x = 1;\n',
  });
}

const messages = (findings: ReadonlyArray<{ path: string; message: string }>): string[] => findings.map((f) => `${f.path}: ${f.message}`);

describe('gitignoredLintFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it("flags a linted file the repository's ignore files ignore, and not one only a personal exclude ignores", () => {
    writeFiles(root, {
      '.gitignore': 'build/\n',
      'packages/a/src/ok.ts': '',
      'packages/a/build/out.ts': '',
    });
    commitAllAsRepo(root);
    // Untracked, as a personal exclude only ever hides an untracked file.
    writeFiles(root, { 'packages/a/src/personal.ts': '', '.git/info/exclude': 'personal.ts\n' });
    const plans = [{ dir: 'a', lintable: ['packages/a/build/out.ts', 'packages/a/src/ok.ts', 'packages/a/src/personal.ts'], foreign: [] }];
    expect(messages(gitignoredLintFindings(root, plans))).toEqual([expect.stringMatching(/^packages\/a\/build\/out\.ts: ESLint lints this file but git ignores it/)]);
  });
});

describe('ignoreFileFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('requires the declared list to equal the tracked ignore files, and both lint tasks to hash exactly those', () => {
    writeFiles(root, {
      '.gitignore': 'x\n',
      'packages/a/.gitignore': 'y\n',
      'turbo.json': turboWith(['$TURBO_ROOT$/.gitignore', '$TURBO_ROOT$/gone/.gitignore'], ['.gitignore', 'gone/.gitignore']),
    });
    commitAllAsRepo(root);
    expect(messages(ignoreFileFindings(root, ['.gitignore', 'gone/.gitignore']))).toEqual([
      expect.stringMatching(/^packages\/a\/\.gitignore: A tracked ignore file .* does not list/),
      expect.stringMatching(/^eslint-config-support\.js: IGNORE_FILES lists gone\/\.gitignore, which is not a tracked \.gitignore/),
    ]);
    expect(messages(ignoreFileFindings(root, ['.gitignore', 'packages/a/.gitignore']))).toEqual([
      expect.stringMatching(/"lint" task does not hash \$TURBO_ROOT\$\/packages\/a\/\.gitignore/),
      expect.stringMatching(/"lint" task hashes \$TURBO_ROOT\$\/gone\/\.gitignore, which IGNORE_FILES does not list/),
      expect.stringMatching(/"\/\/#lint:root" task does not hash packages\/a\/\.gitignore/),
      expect.stringMatching(/"\/\/#lint:root" task hashes gone\/\.gitignore/),
    ]);
  });
});

describe('collectLintConfigFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('passes a repository whose lint wiring is right', async () => {
    writeCleanRepo(root);
    writeFiles(root, { 'packages/a/tsconfig.eslint.json': renderTsconfigEslint() });
    commitAllAsRepo(root);
    expect(messages(await collectLintConfigFindings(root))).toEqual([]);
  });

  it('reports a stale generated file, a wrong script, an unhashed config import and a root lint place', async () => {
    writeCleanRepo(root);
    writeFiles(root, {
      'packages/a/package.json': JSON.stringify({ name: 'a', type: 'module', scripts: { lint: 'eslint .', typecheck: TYPECHECK_SCRIPT } }),
      'eslint.config.js': "import './eslint-config-support.js';\nimport './more.js';\nexport default [{ files: ['**/*.ts', '**/*.js'] }];\n",
      'more.js': 'export {};\n',
      'tools/run.js': 'export {};\n',
    });
    commitAllAsRepo(root);
    const found = messages(await collectLintConfigFindings(root));
    expect(found).toEqual(expect.arrayContaining([
      expect.stringMatching(/^packages\/a\/tsconfig\.eslint\.json: Generated from what ESLint lints/),
      expect.stringMatching(/^packages\/a\/package\.json: `lint` must be exactly/),
      expect.stringMatching(/^turbo\.json: eslint\.config\.js imports \.\/more\.js, which no input of the "lint" task matches/),
      expect.stringMatching(/^turbo\.json: The "\/\/#lint:root" task lints files that "tools\/\*\*\/\*\.\{js,/),
    ]));
    expect(found).toHaveLength(4);
  });
});
