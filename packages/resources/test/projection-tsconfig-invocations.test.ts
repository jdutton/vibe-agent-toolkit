/**
 * `tsconfig_invocations` tokenisation (`projection/tsconfig-invocations.ts`): which script segments
 * run a compiler, which projects they name, and what becomes a condition or an outside-root mark.
 */

import { describe, expect, it } from 'vitest';

import { formatContentKey } from '../src/content-key.js';
import { compilersFromConfig, invocationsOf, type InvocationInput } from '../src/projection/tsconfig-invocations.js';
import { ProjectConfigSchema } from '../src/schemas/project-config.js';
import type { DataNodeRow } from '../src/schemas/projection-data.js';
import { DEFAULT_TSCONFIG_COMPILERS } from '../src/schemas/projection-tsconfig.js';

const ROOT = 'root-1';
const BLOB = formatContentKey({ parserKind: 'none', keyKind: 'sha256', hex: 'a'.repeat(64) });

/** A package.json's nodes: an object with a name and scripts; `scripts` is a list so a name may repeat. */
function nodesOf(scripts: ReadonlyArray<readonly [string, string]>, name: string | null = 'pkg'): DataNodeRow[] {
  const rows: DataNodeRow[] = [];
  const base = { blob: BLOB, variant: 'json', doc: 0, tag: null, aliasOf: null, column: 1, lexeme: null } as const;
  let ordinal = 0;
  const add = (row: Partial<DataNodeRow> & Pick<DataNodeRow, 'pointer' | 'key' | 'type' | 'parent' | 'depth'>): number => {
    const at = ordinal++;
    rows.push({ ...base, ordinal: at, idx: null, value: null, childCount: 0, shadowed: false, line: 1, ...row } as DataNodeRow);
    return at;
  };
  add({ pointer: '', key: null, type: 'object', parent: null, depth: 1 });
  if (name !== null) add({ pointer: '/name', key: 'name', type: 'string', parent: 0, depth: 2, value: name });
  const scriptsAt = add({ pointer: '/scripts', key: 'scripts', type: 'object', parent: 0, depth: 2 });
  const last = new Map(scripts.map(([key], index) => [key, index]));
  for (const [index, [key, value]] of scripts.entries()) {
    add({
      pointer: `/scripts/${key}`, key, type: 'string', parent: scriptsAt, depth: 3, value,
      shadowed: last.get(key) !== index, line: 10 + index,
    });
  }
  return rows;
}

function run(scripts: ReadonlyArray<readonly [string, string]>, extra: Partial<InvocationInput> = {}): ReturnType<typeof invocationsOf> {
  return invocationsOf({
    root: ROOT,
    path: 'packages/a/package.json',
    nodes: nodesOf(scripts),
    compilers: DEFAULT_TSCONFIG_COMPILERS,
    isGitContent: () => true,
    ...extra,
  });
}

describe('invocationsOf', () => {
  it('reads the default project of a bare compiler segment', () => {
    const { invocations, conditions, outsideRoot } = run([['build', 'tsc']]);
    expect(conditions).toEqual([]);
    expect(outsideRoot).toEqual([]);
    expect(invocations).toEqual([{
      root: ROOT, path: 'packages/a/package.json', script: 'build', segment: 0, ordinal: 0,
      package: 'pkg', packageDir: 'packages/a', compiler: 'tsc',
      project: 'packages/a/tsconfig.json', config: 'packages/a/tsconfig.json', buildMode: false, line: 10,
    }]);
  });

  it('splits on &&, || and ; and numbers the compiling segments by their position', () => {
    const { invocations } = run([['x', 'tsc -p a.json && echo hi || tsc -p b.json ; tsc -p c.json']]);
    expect(invocations.map((row) => [row.segment, row.project])).toEqual([
      [0, 'packages/a/a.json'], [2, 'packages/a/b.json'], [3, 'packages/a/c.json'],
    ]);
  });

  it('resolves -p . and --project dir to the directory\'s tsconfig.json', () => {
    const { invocations } = run([['a', 'tsc -p .'], ['b', 'tsc --project src']], { isGitContent: (path) => path.endsWith('tsconfig.json') });
    expect(invocations.map((row) => row.config)).toEqual(['packages/a/tsconfig.json', 'packages/a/src/tsconfig.json']);
    expect(invocations.map((row) => row.project)).toEqual(['packages/a', 'packages/a/src']);
  });

  it('takes every build-mode positional as a project, ordinal by position', () => {
    const { invocations } = run([['b', 'tsc -b src test/tsconfig.test.json --verbose']]);
    expect(invocations.map((row) => [row.ordinal, row.config, row.buildMode])).toEqual([
      [0, 'packages/a/src/tsconfig.json', true], [1, 'packages/a/test/tsconfig.test.json', true],
    ]);
  });

  it('reads a build-mode segment with no positional as the default project', () => {
    const { invocations } = run([['b', 'tsc --build']]);
    expect(invocations.map((row) => [row.config, row.buildMode])).toEqual([['packages/a/tsconfig.json', true]]);
  });

  it('finds a compiler reached through a path or a launcher', () => {
    const { invocations } = run([['a', 'node_modules/.bin/tsc -p x.json'], ['b', 'npx tsc-native']]);
    expect(invocations.map((row) => row.compiler)).toEqual(['tsc', 'tsc-native']);
  });

  it('reads a repeated script name by its last occurrence', () => {
    const { invocations } = run([['build', 'tsc -p old.json'], ['build', 'tsc -p new.json']]);
    expect(invocations.map((row) => [row.project, row.line])).toEqual([['packages/a/new.json', 11]]);
  });

  it('ignores a segment that runs no compiler, and a compiler named only as an argument value', () => {
    const { invocations } = run([['lint', 'eslint . && vitest run'], ['t', 'echo tscx']]);
    expect(invocations).toEqual([]);
  });

  it('reports a named file absent from git content as TSCONFIG_INVOKED_MISSING with a null config', () => {
    const { invocations, conditions } = run([['b', 'tsc -p tsconfig.build.json']], {
      isGitContent: (path) => path !== 'packages/a/tsconfig.build.json',
    });
    expect(invocations.map((row) => row.config)).toEqual([null]);
    expect(conditions).toEqual([expect.objectContaining({
      root: ROOT, path: 'packages/a/package.json', code: 'TSCONFIG_INVOKED_MISSING', seq: 0, kind: null, reached: null,
    })]);
    expect(conditions[0]?.message).toContain('packages/a/tsconfig.build.json');
  });

  it('numbers the missing conditions of one package.json in order', () => {
    const { conditions } = run([['a', 'tsc -p x.json'], ['b', 'tsc -p y.json']], { isGitContent: () => false });
    expect(conditions.map((row) => row.seq)).toEqual([0, 1]);
  });

  it('marks a project that leaves the root, with a null config and no missing condition', () => {
    const { invocations, conditions, outsideRoot } = run([['a', 'tsc -p ../../../x']]);
    expect(invocations.map((row) => [row.project, row.config])).toEqual([['../x', null]]);
    expect(conditions).toEqual([]);
    expect(outsideRoot).toEqual(invocations);
  });

  it('does not mark a project that climbs and returns inside the root', () => {
    const { invocations, outsideRoot } = run([['a', 'tsc -p ../b']], { isGitContent: (path) => path.endsWith('.json') });
    expect(invocations[0]?.config).toBe('packages/b/tsconfig.json');
    expect(outsideRoot).toEqual([]);
  });

  it('uses the configured compiler set instead of the default', () => {
    const custom = run([['a', 'tsgo -p x.json && tsc']], { compilers: ['tsgo'] });
    expect(custom.invocations.map((row) => row.compiler)).toEqual(['tsgo']);
  });

  it('puts the root package at the root', () => {
    const { invocations } = invocationsOf({
      root: ROOT, path: 'package.json', nodes: nodesOf([['b', 'tsc']], null),
      compilers: DEFAULT_TSCONFIG_COMPILERS, isGitContent: () => true,
    });
    expect(invocations[0]).toMatchObject({ packageDir: '.', project: 'tsconfig.json', config: 'tsconfig.json', package: null });
  });
});

/** The projects of `command`, run with only `files` as git content. */
function projectsOf(command: string, files: readonly string[], packagePath = 'packages/a/package.json'): ReturnType<typeof invocationsOf> {
  return run([['s', command]], { path: packagePath, isGitContent: (path) => files.includes(path) });
}

describe('invocationsOf follows tsc\'s command line', () => {
  it('a bare tsc walks up to the nearest tsconfig.json, as findConfigFile does', () => {
    const { invocations, conditions } = projectsOf('tsc --noEmit', ['tsconfig.json']);
    expect(invocations.map((row) => [row.project, row.config])).toEqual([['tsconfig.json', 'tsconfig.json']]);
    expect(conditions).toEqual([]);
  });

  it('a bare tsc prefers the package\'s own tsconfig.json to an ancestor\'s', () => {
    const { invocations } = projectsOf('tsc', ['tsconfig.json', 'packages/a/tsconfig.json']);
    expect(invocations.map((row) => row.config)).toEqual(['packages/a/tsconfig.json']);
  });

  it('a bare tsc that finds none inside the root says it cannot know, not that a file is missing', () => {
    const { invocations, conditions } = projectsOf('tsc --noEmit', []);
    expect(invocations).toEqual([]);
    expect(conditions.map((row) => [row.code, row.seq])).toEqual([['TSCONFIG_INVOKED_UNKNOWN', 0]]);
  });

  it.each([
    ['source files, no config', 'tsc src/cli.ts --outDir dist'],
    ['source files beside -p (TS5042)', 'tsc -p tsconfig.json src/a.ts'],
    ['--project=x, which tsc rejects (TS5023)', 'tsc --project=lib'],
    ['--version', 'tsc --version'],
    ['-v', 'tsc -v'],
    ['--init', 'tsc --init'],
    ['--help', 'tsc --help'],
    ['--showConfig', 'tsc --showConfig'],
    ['-b --clean', 'tsc -b --clean'],
    ['-b not first', 'tsc --noEmit -b'],
    ['-p in build mode', 'tsc -b -p x.json'],
  ])('%s: no row and no condition', (_name, command) => {
    const { invocations, conditions, outsideRoot } = projectsOf(command, ['tsconfig.json', 'packages/a/tsconfig.json', 'packages/a/x.json']);
    expect([invocations, conditions, outsideRoot]).toEqual([[], [], []]);
  });

  it('a source file value of a value-taking option is not a source file', () => {
    const { invocations } = projectsOf('tsc --outFile dist/bundle.js --target es2022', ['packages/a/tsconfig.json']);
    expect(invocations.map((row) => row.config)).toEqual(['packages/a/tsconfig.json']);
  });

  it('a pipe or a redirection ends the compiler\'s arguments', () => {
    const { invocations } = projectsOf('tsc -p x.json 2>&1 | tee out.log', ['packages/a/x.json']);
    expect(invocations.map((row) => row.config)).toEqual(['packages/a/x.json']);
  });

  it('option names are case-insensitive, their values are not', () => {
    const { invocations } = projectsOf('tsc -P Tsconfig.App.json --Project tsconfig.Lib.json', ['packages/a/tsconfig.Lib.json']);
    expect(invocations.map((row) => row.config)).toEqual(['packages/a/tsconfig.Lib.json']);
  });

  it('-b counts only as the first argument and --build is case-insensitive', () => {
    expect(projectsOf('tsc --Build src', ['packages/a/src/tsconfig.json']).invocations.map((row) => row.buildMode)).toEqual([true]);
  });

  it('-p names a file when the path is git content (any extension), a directory otherwise', () => {
    const files = ['packages/a/tsconfig.app.jsonc', 'packages/a/lib/tsconfig.json'];
    expect(projectsOf('tsc -p tsconfig.app.jsonc', files).invocations.map((row) => row.config)).toEqual(['packages/a/tsconfig.app.jsonc']);
    expect(projectsOf('tsc -p lib', files).invocations.map((row) => row.config)).toEqual(['packages/a/lib/tsconfig.json']);
  });

  it.each([
    ['a cd earlier in the script', 'cd packages/b && tsc -p tsconfig.json'],
    ['a subshell cd', '(cd packages/b; tsc -p tsconfig.json)'],
    ['pnpm -C', 'pnpm -C packages/b exec tsc -p tsconfig.json'],
    ['pnpm --filter', 'pnpm --filter b exec tsc'],
    ['npm --prefix', 'npm --prefix packages/b exec -- tsc -p tsconfig.json'],
    ['a shell glob', 'tsc -b packages/*'],
    ['a variable', 'tsc -p $PROJECT'],
    ['a response file', 'tsc @args.txt'],
  ])('%s: TSCONFIG_INVOKED_UNKNOWN, no row and no missing condition', (_name, command) => {
    const { invocations, conditions, outsideRoot } = projectsOf(command, ['packages/a/tsconfig.json']);
    expect(invocations).toEqual([]);
    expect(outsideRoot).toEqual([]);
    expect(conditions.map((row) => row.code)).toEqual(['TSCONFIG_INVOKED_UNKNOWN']);
  });

  it('numbers each code\'s conditions of a package.json separately', () => {
    const { conditions } = run([['a', 'tsc -p x.json'], ['b', 'cd q && tsc'], ['c', 'tsc -p y.json']], { isGitContent: () => false });
    expect(conditions.map((row) => [row.code, row.seq])).toEqual([['TSCONFIG_INVOKED_MISSING', 0], ['TSCONFIG_INVOKED_UNKNOWN', 0], ['TSCONFIG_INVOKED_MISSING', 1]]);
  });
});

describe('resources.typescript.compilers', () => {
  it('is accepted as a string array and defaults to nothing in the parsed config', () => {
    expect(ProjectConfigSchema.parse({ resources: { typescript: { compilers: ['tsgo'] } } }).resources?.typescript?.compilers).toEqual(['tsgo']);
    expect(ProjectConfigSchema.parse({ resources: {} }).resources?.typescript).toBeUndefined();
  });

  it('reaches callers through compilersFromConfig, which falls back to the default', () => {
    expect(compilersFromConfig(undefined)).toEqual(DEFAULT_TSCONFIG_COMPILERS);
    expect(compilersFromConfig(ProjectConfigSchema.parse({ resources: {} }))).toEqual(DEFAULT_TSCONFIG_COMPILERS);
    expect(compilersFromConfig(ProjectConfigSchema.parse({ resources: { typescript: { compilers: ['tsgo'] } } }))).toEqual(['tsgo']);
  });

  it('refuses a misspelled key', () => {
    expect(() => ProjectConfigSchema.parse({ resources: { typescript: { compiler: [] } } })).toThrow();
  });
});
