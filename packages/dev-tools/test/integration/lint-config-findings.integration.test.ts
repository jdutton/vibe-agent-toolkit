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
  planLintConfig,
  renderTsconfigEslint,
  ROOT_LINT_EXTENSIONS,
  ROOT_TYPECHECK_GLOB,
  rootTypecheckInputFindings,
} from '../../src/generate-lint-config.js';
import { cleanupTestTempDir, commitAllAsRepo, createTestTempDir, writeFiles } from '../test-helpers.js';

/** The typecheck guard every fixture repository carries: the task script and the file it imports. */
const GUARD_FILES = ['typecheck-task.js', 'eslint-config-support.js'];

/**
 * A root turbo.json whose two lint tasks carry `lint` and `rootLint` as inputs, and whose two
 * typecheck tasks carry what those imply (plus `rootTypecheck` for the root program's own files).
 */
function turboWith(lint: readonly string[], rootLint: readonly string[], rootTypecheck: readonly string[] = []): string {
  const program = lint.filter((input) => input === '$TURBO_DEFAULT$' || input.endsWith('node_modules/typescript/package.json'));
  const typecheck = [...program, ...GUARD_FILES.map((rel) => `$TURBO_ROOT$/${rel}`)];
  const typecheckRoot = [...rootTypecheck, ...program.filter((input) => input.startsWith('$TURBO_ROOT$/')).map((input) => input.slice('$TURBO_ROOT$/'.length)), ...GUARD_FILES];
  return JSON.stringify({ tasks: { lint: { inputs: lint }, typecheck: { inputs: typecheck }, '//#typecheck:root': { inputs: typecheckRoot }, '//#lint:root': { inputs: rootLint } } });
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
    'typecheck-task.js': "import './eslint-config-support.js';\n",
    'turbo.json': turboWith(
      ['$TURBO_DEFAULT$', '$TURBO_ROOT$/eslint-config-support.js', '$TURBO_ROOT$/.gitignore', ...linterInputs.map((n) => `$TURBO_ROOT$/node_modules/${n}/package.json`)],
      [`*.${ROOT_LINT_EXTENSIONS}`, '.gitignore', ...linterInputs.map((n) => `node_modules/${n}/package.json`)],
    ),
    'packages/a/package.json': JSON.stringify({ name: 'a', type: 'module', scripts: { lint: LINT_SCRIPT } }),
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
      'packages/a/package.json': JSON.stringify({ name: 'a', type: 'module', scripts: { lint: 'eslint .' } }),
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

describe('planLintConfig', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it("traces foreign inputs from the program's own files, so a fixture ESLint ignores still contributes its relative import", async () => {
    writeCleanRepo(root);
    writeFiles(root, {
      'eslint.config.js': "import './eslint-config-support.js';\nexport default [{ ignores: ['**/test/fixtures/**'] }, { files: ['**/*.ts', '**/*.js'] }];\n",
      'packages/a/tsconfig.eslint.json': renderTsconfigEslint(),
      'packages/a/test/fixtures/uses-helper.ts': "import { helper } from '../../../b/src/helper.js';\nexport const y = helper;\n",
      'packages/b/package.json': JSON.stringify({ name: 'b', type: 'module' }),
      'packages/b/src/helper.ts': 'export const helper = 1;\n',
    });
    commitAllAsRepo(root);
    const plan = (await planLintConfig(root)).find((p) => p.dir === 'a');
    expect(plan?.lintable).not.toContain('packages/a/test/fixtures/uses-helper.ts');
    expect(plan?.foreign).toEqual(['packages/b/src/helper.ts']);
  });
});

/** The `lint` inputs of every root-program fixture: only the two that describe a program. */
const ROOT_PROGRAM_LINT = ['$TURBO_DEFAULT$', '$TURBO_ROOT$/node_modules/typescript/package.json'];

/**
 * A clean repository with a root program: a root-level config that imports a helper below the root,
 * which imports a type from beside it; `//#typecheck:root` carries `rootTypecheck` plus the inputs
 * every root typecheck shares.
 */
function writeRootProgram(root: string, rootTypecheck: readonly string[]): void {
  writeCleanRepo(root);
  writeFiles(root, {
    'tsconfig.root.json': JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { noEmit: true, allowImportingTsExtensions: true }, include: ['*.ts', '*.cts', '*.mts'] }),
    'vitest.config.ts': "import { helper } from './tools/helper.ts';\nexport default helper;\n",
    'tools/helper.ts': "import type { X } from './types.ts';\nexport const helper: X = 1;\n",
    'tools/types.ts': 'export type X = number;\n',
    'turbo.json': turboWith(ROOT_PROGRAM_LINT, [], rootTypecheck),
  });
}

describe('rootTypecheckInputFindings', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir();
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  it('accepts the root-level glob, each deeper file the program reaches, the program inputs and the guard', () => {
    writeRootProgram(root, [ROOT_TYPECHECK_GLOB, 'tools/helper.ts', 'tools/types.ts']);
    expect(messages(rootTypecheckInputFindings(root))).toEqual([]);
  });

  it('flags a reached file it lacks and an input the program does not read, both ways', () => {
    writeRootProgram(root, [ROOT_TYPECHECK_GLOB, 'tools/helper.ts', 'tools/unrelated.ts']);
    expect(messages(rootTypecheckInputFindings(root))).toEqual([
      expect.stringMatching(/^turbo\.json: The "\/\/#typecheck:root" task does not hash tools\/types\.ts/),
      expect.stringMatching(/^turbo\.json: The "\/\/#typecheck:root" task hashes tools\/unrelated\.ts/),
    ]);
  });

  it('drops a file a globalDependencies entry already hashes', () => {
    writeRootProgram(root, [ROOT_TYPECHECK_GLOB, 'tools/types.ts']);
    const turbo = JSON.parse(turboWith(ROOT_PROGRAM_LINT, [], [ROOT_TYPECHECK_GLOB, 'tools/types.ts'])) as Record<string, unknown>;
    writeFiles(root, { 'turbo.json': JSON.stringify({ ...turbo, globalDependencies: ['tools/helper.ts'] }) });
    expect(messages(rootTypecheckInputFindings(root))).toEqual([]);
  });
});
