/**
 * The lint task's input contract, judged by turbo itself (`turbo run lint --dry=json`) on a fixture
 * workspace that carries this repository's real `lint` task definition.
 *
 * A package's lint is cached by turbo, so a verdict is only as fresh as the task's hash. The
 * contract: a change to anything the package's program reads (a dependency's emitted declarations,
 * a file it reaches by a relative import into another package) changes the hash; a change a
 * dependent cannot see (a dependency's source that leaves its declarations byte-identical) does
 * not; and the task has no `dependsOn`, whose upstream hash would change with every source edit.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECT_ROOT, safeExecResult } from '../../src/common.js';
import { foreignLintInputs, renderPackageTurbo, renderTsconfigEslint } from '../../src/generate-lint-config.js';
import { cleanupTestTempDir, commitAllAsRepo, createTestTempDir, writeFiles } from '../test-helpers.js';

interface LintTaskDefinition {
  readonly dependsOn?: readonly string[];
  readonly inputs?: readonly string[];
  readonly [key: string]: unknown;
}

/** This repository's `lint` task, as `turbo.json` declares it. */
function realLintTask(): LintTaskDefinition {
  const text = readFileSync(safePath.join(PROJECT_ROOT, 'turbo.json'), 'utf8');
  const config = ts.parseConfigFileTextToJson('turbo.json', text).config as { tasks: Record<string, LintTaskDefinition> };
  const lint = config.tasks['lint'];
  if (lint === undefined) throw new Error('turbo.json declares no lint task');
  return lint;
}

interface DryTask {
  readonly hash: string;
  readonly inputs: Record<string, string>;
}

/** Every lint task in the fixture, from turbo's own dry run. */
function lintTasks(root: string): Map<string, DryTask> {
  const launcher = safePath.join(PROJECT_ROOT, 'node_modules', 'turbo', 'bin', 'turbo');
  const result = safeExecResult(process.execPath, [launcher, 'run', 'lint', '--dry=json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
  });
  if (result.status !== 0) throw new Error(`turbo --dry=json failed: ${String(result.stderr).slice(-2000)}`);
  const graph = JSON.parse(String(result.stdout)) as { tasks: Array<DryTask & { taskId: string }> };
  return new Map(graph.tasks.map((task) => [task.taskId, task]));
}

const APP = 'app#lint';

/** The app's lint hash after writing `text` to `rel` under `root`, with the file restored afterwards. */
function appHashAfter(root: string, rel: string, text: string): string | undefined {
  const file = safePath.join(root, rel);
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, text);
  try {
    return lintTasks(root).get(APP)?.hash;
  } finally {
    writeFileSync(file, before);
  }
}

describe('the lint task definition', () => {
  it('has no dependsOn, so no upstream build hash enters the lint hash', () => {
    expect(realLintTask().dependsOn ?? []).toEqual([]);
  });
});

describe('the lint task input contract (turbo dry run)', () => {
  let root: string;
  let baseline: Map<string, DryTask>;

  beforeAll(() => {
    root = createTestTempDir();
    writeFiles(root, {
      'package.json': JSON.stringify({ name: 'fixture', private: true, packageManager: 'bun@1.3.9', workspaces: ['packages/*'] }),
      'bun.lock': JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'fixture' }, 'packages/dep': { name: 'dep' }, 'packages/app': { name: 'app', dependencies: { dep: 'workspace:*' } } }, packages: { dep: ['dep@workspace:packages/dep'] } }),
      'turbo.json': JSON.stringify({ tasks: { lint: realLintTask() } }),
      'packages/dep/package.json': JSON.stringify({ name: 'dep', types: './dist/index.d.ts', scripts: { lint: 'true' } }),
      'packages/dep/src/index.ts': 'export function f(): void {}\n',
      'packages/dep/dist/index.d.ts': 'export declare function f(): void;\n',
      'packages/dep/test/helpers.ts': 'export function help(): void {}\n',
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { dep: 'workspace:*' }, scripts: { lint: 'true' } }),
      'packages/app/src/a.ts': "import { f } from 'dep';\nf();\n",
      'packages/app/test/a.test.ts': "import { help } from '../../dep/test/helpers.js';\nhelp();\n",
      // As in this repository: built output is ignored, so only an explicit glob can hash it.
      '.gitignore': 'dist/\nnode_modules/\n',
    });
    // The generated package turbo.json, from the generator itself.
    writeFiles(root, { 'tsconfig.base.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', types: [] } }), 'packages/app/tsconfig.eslint.json': renderTsconfigEslint() });
    const foreign = foreignLintInputs(root, 'app', () => false, new Map());
    expect(foreign).toEqual(['packages/dep/test/helpers.ts']);
    writeFiles(root, { 'packages/app/turbo.json': renderPackageTurbo(undefined, foreign) ?? '' });
    // A real repository, so turbo hashes what git tracks and skips what it ignores.
    commitAllAsRepo(root);
    baseline = lintTasks(root);
  });

  afterAll(() => {
    cleanupTestTempDir(root);
  });

  it('hashes a gitignored dist declaration through the $TURBO_ROOT$ glob', () => {
    expect(() => runGitOrThrow(['check-ignore', '-q', 'packages/dep/dist/index.d.ts'], { cwd: root })).not.toThrow();
    expect(Object.keys(baseline.get(APP)?.inputs ?? {})).toContain('../dep/dist/index.d.ts');
  });

  it('changes the dependent\'s hash when a dependency\'s emitted declaration changes', () => {
    expect(baseline.get(APP)).toBeDefined();
    expect(appHashAfter(root, 'packages/dep/dist/index.d.ts', 'export declare function f(): Promise<void>;\n')).not.toBe(baseline.get(APP)?.hash);
  });

  it('keeps the dependent\'s hash when a dependency\'s source changes and its declaration does not', () => {
    expect(appHashAfter(root, 'packages/dep/src/index.ts', 'export function f(): void {\n  // a body edit\n}\n')).toBe(baseline.get(APP)?.hash);
  });

  it('changes the importer\'s hash when a file it reaches by a relative import into another package changes', () => {
    expect(appHashAfter(root, 'packages/dep/test/helpers.ts', 'export async function help(): Promise<void> {}\n')).not.toBe(baseline.get(APP)?.hash);
  });
});
