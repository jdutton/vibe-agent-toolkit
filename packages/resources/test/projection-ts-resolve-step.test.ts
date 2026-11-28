/**
 * The TypeScript resolve step (`projection/ts-resolve-step.ts`) over the data stage's declared-reads
 * handle: the stage runs over an in-memory fixture (`/repo`, `root-1`, store off) with the workspace
 * and tsconfig steps (the tsconfig job in-process) and the `ts` instance staged, then the step runs
 * over its answers, with the vendored TypeScript in process. Every `targetKind` (no collected
 * reference has a null specifier, so there is no non-literal kind), the walk, the caches, the stand-in cache,
 * every refusal, the skew row, and the reads it names.
 */

import { readWorkCounters, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { RowSetDemand } from '../src/projection/data-stage.js';
import type { DeclaredPair, DeclaredReads } from '../src/projection/declared-reads.js';
import { tsRoutingFor, type TsRouting } from '../src/projection/router.js';
import { resolveTsImports, type TsResolveAnswer, type TsResolveRows } from '../src/projection/ts-resolve-step.js';
import { workspaceLinks, type WorkspaceLinkTable } from '../src/projection/workspace-links.js';
import type { ProjectConfig } from '../src/schemas/project-config.js';
import type { TsImportTargetRow } from '../src/schemas/projection-ts-resolve.js';
import { DEFAULT_TSCONFIG_COMPILERS } from '../src/schemas/projection-tsconfig.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

import { inProcessTsconfigParse, stagedWithReads, type Realized } from './helpers/data-stage-fixture.js';

const ROOT_ID = 'root-1';
const ROOT_PATH = '/repo';
const A = 'packages/a/tsconfig.json';
const A_INDEX = 'packages/a/src/index.ts';
const C_SOURCE = 'packages/c/src/index.ts';
const NODENEXT = { module: 'nodenext', moduleResolution: 'nodenext' } as const;

/** The workspace and tsconfig steps, and the `ts` instance with its routes: everything the step reads (the step itself is called by the test, so the stage does not run it). */
const T2_DEMAND: RowSetDemand = { tables: [], dataRoutes: false, dataValues: false, tsRoutes: true, tsImports: false, workspace: true, tsconfig: true, tsResolve: false };

/** The vendored TypeScript, in process: the step runs it as the stage would hand it over. */
const typescript: typeof ts = await loadVendoredTypeScript();

/** @returns A realization holding `value` as pretty JSON */
const json = (path: string, value: unknown): Realized => ({ path, text: `${JSON.stringify(value, null, 2)}\n` });

/** @returns A realization holding source lines */
function source(path: string, ...lines: string[]): Realized {
  return { path, text: `${lines.join('\n')}\n` };
}

/** A pnpm workspace over `packages/*`, its root running `tsc -p` over each project named. */
function pnpmWorkspace(projects: readonly string[], rootExtra: Record<string, unknown> = {}): Realized[] {
  const scripts = Object.fromEntries(projects.map((project, index) => [`build${String(index)}`, `tsc -p ${project}`]));
  return [
    json('package.json', { name: 'root', private: true, packageManager: 'pnpm@9.0.0', scripts, ...rootExtra }),
    { path: 'pnpm-workspace.yaml', text: 'packages:\n  - packages/*\n' },
  ];
}

/** What one run of the step saw and answered. */
interface Run {
  readonly answer: TsResolveAnswer;
  /** Every read through the handle: the pairs read, in order. */
  readonly reads: DeclaredPair[][];
  /** Each counter the step moved. */
  readonly moved: Partial<Record<WorkCounter, number>>;
}

/** How one run is set up. */
interface RunOptions {
  readonly tsRouting?: TsRouting;
  /** Replaces the link tables built from the workspace step's rows. */
  readonly links?: ReadonlyMap<string, WorkspaceLinkTable>;
}

/** Run the stage over `files`, then the step over its answers and handle. */
async function resolve(files: readonly Realized[], options: RunOptions = {}): Promise<Run> {
  const gitContent = files.map((file) => ({ root: ROOT_ID, repository: '', path: file.path }));
  const { result, declaredReads: stageReads } = await stagedWithReads(files, {
    demand: T2_DEMAND,
    ...(options.tsRouting === undefined ? {} : { tsRouting: options.tsRouting }),
    tsconfig: { gitContent, compilers: DEFAULT_TSCONFIG_COMPILERS, parse: inProcessTsconfigParse(typescript) },
  });
  if (result.tsconfig === undefined) throw new Error('the stage ran no tsconfig step');
  const reads: DeclaredPair[][] = [];
  const declaredReads = (declared: readonly DeclaredPair[]): DeclaredReads => {
    const handle = stageReads(declared);
    return {
      read: (pairs, request) => {
        reads.push([...pairs]);
        return handle.read(pairs, request);
      },
    };
  };
  const { workspace } = result;
  const links = options.links ?? new Map(workspace?.outcome === 'rows' ? [[ROOT_ID, workspaceLinks(workspace.packages, workspace.dependencies, false)]] : []);
  const before = readWorkCounters();
  const answer = await resolveTsImports({
    roots: [{ id: ROOT_ID, path: ROOT_PATH }],
    tsconfig: result.tsconfig,
    workspace,
    links,
    gitContent,
    tsRoutes: result.derived.tsRoutes ?? [],
    declaredReads,
    typescript,
  });
  const after = readWorkCounters();
  const moved = Object.fromEntries((Object.keys(after) as WorkCounter[]).filter((name) => after[name] !== before[name]).map((name) => [name, after[name] - before[name]]));
  return { answer, reads, moved };
}

/** @returns The answer's rows, failing on a refusal */
function rowsOf(run: Run): TsResolveRows {
  if (run.answer.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(run.answer.refusal)}`);
  return run.answer.rows;
}

/** @returns The answer's refusal, failing on rows */
function refusalOf(run: Run): Extract<TsResolveAnswer, { outcome: 'refused' }>['refusal'] {
  if (run.answer.outcome !== 'refused') throw new Error('expected a refusal');
  return run.answer.refusal;
}

/** @returns The targets of one config and file, by specifier, with the outcome columns */
function targetsOf(rows: TsResolveRows, config: string, path: string): Record<string, Pick<TsImportTargetRow, 'targetKind' | 'target' | 'redirected' | 'mode'>> {
  return Object.fromEntries(rows.targets
    .filter((row) => row.config === config && row.path === path)
    .map((row) => [row.specifier ?? `#${String(row.ordinal)}`, { targetKind: row.targetKind, target: row.target, redirected: row.redirected, mode: row.mode }]));
}

// ── The main fixture: `a` declares `@acme/c` (built to `dist`), not `@acme/d` ──

/** `a` reaches every kind; `c`'s `exports` name its built output; `d` is a member `a` never declares. */
function memberWorkspace(): Realized[] {
  return [
    ...pnpmWorkspace(['packages/a', 'packages/c']),
    json('packages/a/package.json', { name: 'a', type: 'module', dependencies: { '@acme/c': 'workspace:*' } }),
    json(A, { compilerOptions: { ...NODENEXT, outDir: 'dist', types: [] }, files: ['src/index.ts'] }),
    source(A_INDEX,
      '/// <reference lib="es2022" />',
      "import { b } from './b.js';",
      "import { c } from '@acme/c';",
      "import { d } from '@acme/d';",
      "import pad from 'left-pad';",
      "import fs from 'node:fs';",
      "import gone from './missing.js';",
      "import type { Old } from '../dist/old.js';",
      'export { b, c, d, pad, fs, gone };',
      'export type { Old };'),
    source('packages/a/src/b.ts', "import { e } from '../lib/extra.js';", "export { c } from './index.js';", 'export const b = e;'),
    source('packages/a/lib/extra.ts', 'export const e = 1;'),
    source('packages/a/dist/old.d.ts', 'export type Old = 1;'),
    json('packages/c/package.json', { name: '@acme/c', type: 'module', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }),
    json('packages/c/tsconfig.json', { compilerOptions: { ...NODENEXT, outDir: 'dist', rootDir: 'src', declaration: true, types: [] }, include: ['src'] }),
    source(C_SOURCE, 'export const c = 1;'),
    json('packages/d/package.json', { name: '@acme/d', exports: './src/index.ts' }),
    source('packages/d/src/index.ts', 'export const d = 1;'),
  ];
}

describe('ts_import_targets: each targetKind', () => {
  it('classifies each reference of a file the way TypeScript resolves it', async () => {
    const rows = rowsOf(await resolve(memberWorkspace()));
    expect(targetsOf(rows, A, A_INDEX)).toStrictEqual({
      'es2022': { targetKind: 'lib', target: null, redirected: false, mode: null },
      './b.js': { targetKind: 'file', target: 'packages/a/src/b.ts', redirected: false, mode: 'import' },
      '@acme/c': { targetKind: 'member', target: C_SOURCE, redirected: true, mode: 'import' },
      '@acme/d': { targetKind: 'memberUndeclared', target: null, redirected: false, mode: 'import' },
      'left-pad': { targetKind: 'external', target: null, redirected: false, mode: 'import' },
      'node:fs': { targetKind: 'builtin', target: null, redirected: false, mode: 'import' },
      './missing.js': { targetKind: 'unresolved', target: null, redirected: false, mode: 'import' },
      '../dist/old.js': { targetKind: 'outputUnmapped', target: 'packages/a/dist/old.d.ts', redirected: false, mode: 'import' },
    });
    expect(rows.targets.find((row) => row.specifier === 'left-pad')).toMatchObject({ package: 'left-pad', pathsMatched: false, kind: 'import', ordinal: 4 });
    expect(rows.targets.find((row) => row.specifier === 'es2022')).toMatchObject({ package: null, kind: 'referenceLib', ordinal: 0 });
  });

  it('member mapping without the output map finds no source: the member target is unresolved', async () => {
    const files = memberWorkspace().map((file) => (file.path === 'packages/c/tsconfig.json' ? json(file.path, { compilerOptions: { ...NODENEXT, noEmit: true }, include: ['src'] }) : file));
    expect(targetsOf(rowsOf(await resolve(files)), A, A_INDEX)['@acme/c']).toStrictEqual({ targetKind: 'unresolved', target: null, redirected: false, mode: 'import' });
  });
});

describe('ts_program_files: the closure walk', () => {
  it('gives every file its shortest distance over a chain and a cycle, and never follows a member', async () => {
    const run = await resolve(memberWorkspace());
    const rows = rowsOf(run);
    expect(rows.programFiles.filter((row) => row.config === A).map((row) => [row.path, row.distance, row.reachedOnly])).toStrictEqual([
      ['packages/a/lib/extra.ts', 2, true],
      ['packages/a/src/b.ts', 1, true],
      [A_INDEX, 0, false],
    ]);
    // The member's own files belong to its own config, which reaches them as root files.
    expect(rows.programFiles.filter((row) => row.path === C_SOURCE)).toStrictEqual([{ root: ROOT_ID, config: 'packages/c/tsconfig.json', path: C_SOURCE, distance: 0, reachedOnly: false }]);
    expect(targetsOf(rows, A, 'packages/a/src/b.ts')['./index.js']).toMatchObject({ targetKind: 'file', target: A_INDEX });
  });

  it('counts configs, config-file pairs, references and one cache pair per config and owning manifest', async () => {
    const run = await resolve(memberWorkspace());
    const rows = rowsOf(run);
    expect(run.moved).toMatchObject({
      'resolve.ts.configs': 2,
      'resolve.ts.files': rows.programFiles.length,
      'resolve.ts.references': rows.targets.length,
      'resolve.ts.hosts': 2,
    });
  });

  it('reads every routed ts pair in one read and every package.json in another, before resolving', async () => {
    const { reads } = await resolve(memberWorkspace());
    expect(reads.map((pairs) => [...new Set(pairs.map((pair) => pair.instance))])).toStrictEqual([['ts'], ['data']]);
    expect(reads[1]?.map((pair) => pair.path)).toStrictEqual(['package.json', 'packages/a/package.json', 'packages/c/package.json', 'packages/d/package.json']);
  });
});

// ── Project references: tsc substitutes a referenced project's declaration output for its sources ──

const B_SOURCE = 'packages/b/src/index.ts';
const B_TYPES = 'packages/b/src/types.d.ts';

/** `a` references `b`, which references `c`; `a` imports both by relative path, and `b`'s own declaration file. */
function referencedProjects(rootConfig?: unknown): Realized[] {
  const composite = { ...NODENEXT, composite: true, outDir: 'dist', rootDir: 'src', types: [] };
  return [
    ...pnpmWorkspace(rootConfig === undefined ? ['packages/a'] : ['packages/a', 'tsconfig.json']),
    ...(rootConfig === undefined ? [] : [json('tsconfig.json', rootConfig)]),
    json('packages/a/package.json', { name: 'a', type: 'module' }),
    json(A, { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, files: ['src/index.ts'], references: [{ path: '../b' }] }),
    source(A_INDEX, "export { b } from '../../b/src/index.js';", "export { c } from '../../c/src/index.js';", "export type { T } from '../../b/src/types.js';"),
    json('packages/b/package.json', { name: 'b', type: 'module' }),
    json('packages/b/tsconfig.json', { compilerOptions: composite, include: ['src'], references: [{ path: '../c' }] }),
    source(B_SOURCE, "export { dep as b } from './dep.js';"),
    source('packages/b/src/dep.ts', 'export const dep = 1;'),
    source(B_TYPES, 'export type T = 1;'),
    json('packages/c/package.json', { name: 'c', type: 'module' }),
    json('packages/c/tsconfig.json', { compilerOptions: composite, include: ['src'] }),
    source(C_SOURCE, 'export const c = 1;'),
  ];
}

describe('project references', () => {
  it('records a referenced project\'s source as a file target and never walks it, transitively; its declaration files are walked', async () => {
    const rows = rowsOf(await resolve(referencedProjects()));
    expect(targetsOf(rows, A, A_INDEX)).toStrictEqual({
      '../../b/src/index.js': { targetKind: 'file', target: B_SOURCE, redirected: false, mode: 'import' },
      '../../c/src/index.js': { targetKind: 'file', target: C_SOURCE, redirected: false, mode: 'import' },
      '../../b/src/types.js': { targetKind: 'file', target: B_TYPES, redirected: false, mode: 'import' },
    });
    expect(rows.programFiles.filter((row) => row.config === A).map((row) => [row.path, row.distance])).toStrictEqual([
      [A_INDEX, 0],
      [B_TYPES, 1],
    ]);
  });

  it('drops a root file that is a referenced project\'s source from the program, as tsc substitutes its output', async () => {
    const rows = rowsOf(await resolve(referencedProjects({ compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, files: [A_INDEX, B_SOURCE], references: [{ path: 'packages/b' }] })));
    expect(rows.programFiles.filter((row) => row.config === 'tsconfig.json').map((row) => row.path)).toStrictEqual([A_INDEX, B_TYPES]);
    expect(rows.targets.filter((row) => row.config === 'tsconfig.json' && row.path === B_SOURCE)).toStrictEqual([]);
  });
});

// ── One cache pair per (config, owning manifest) ──

describe('the caches', () => {
  it('keeps one manifest\'s link out of another\'s files: a declares @acme/c, b does not', async () => {
    const files = [
      ...pnpmWorkspace(['tsconfig.json']),
      json('tsconfig.json', { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, include: ['packages/a/src', 'packages/b/src'] }),
      json('packages/a/package.json', { name: 'a', type: 'module', dependencies: { '@acme/c': 'workspace:*' } }),
      source('packages/a/src/x.ts', "export * from '@acme/c';"),
      json('packages/b/package.json', { name: 'b', type: 'module' }),
      source('packages/b/src/y.ts', "export * from '@acme/c';"),
      json('packages/c/package.json', { name: '@acme/c', type: 'module', exports: './src/index.ts' }),
      source(C_SOURCE, 'export const c = 1;'),
    ];
    const run = await resolve(files);
    const rows = rowsOf(run);
    expect(targetsOf(rows, 'tsconfig.json', 'packages/a/src/x.ts')['@acme/c']).toMatchObject({ targetKind: 'member', target: C_SOURCE });
    expect(targetsOf(rows, 'tsconfig.json', 'packages/b/src/y.ts')['@acme/c']).toMatchObject({ targetKind: 'memberUndeclared', target: null });
    expect(run.moved['resolve.ts.hosts']).toBe(2);
  });

  it('creates one stand-in per (config, scope, extension, text), however many files share it', async () => {
    const files = [
      ...pnpmWorkspace(['packages/a']),
      json('packages/a/package.json', { name: 'a', type: 'module' }),
      json(A, { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, include: ['src'] }),
      source('packages/a/src/one.ts', "import './three.js';"),
      source('packages/a/src/two.ts', "import './three.js';"),
      source('packages/a/src/three.ts', "import './one.js';"),
    ];
    const run = await resolve(files);
    // one.ts and two.ts have the same bytes, so one row set: each still gets its one row.
    expect(rowsOf(run).targets.map((row) => [row.path, row.specifier])).toStrictEqual([
      ['packages/a/src/one.ts', './three.js'],
      ['packages/a/src/three.ts', './one.js'],
      ['packages/a/src/two.ts', './three.js'],
    ]);
    // One mode stand-in (the import's) and one module-detection stand-in (`export {}` absent, no JSX).
    expect(run.moved['resolve.ts.modeStandIns']).toBe(2);
  });
});

describe('noResolve', () => {
  it('resolves the module references but adds no reached file, and processes no path or types directive', async () => {
    const files = onePackage().map((file) => (file.path === 'tsconfig.json' ? json(file.path, { compilerOptions: { ...NODENEXT, noEmit: true, noResolve: true, types: [] }, files: ['src/index.ts'] }) : file))
      .map((file) => (file.path === 'src/index.ts' ? source(file.path, '/// <reference path="./lib/l.ts" />', "export { l } from './lib/l.js';") : file));
    const rows = rowsOf(await resolve(files));
    expect(rows.programFiles.map((row) => row.path)).toStrictEqual(['src/index.ts']);
    expect(rows.targets.map((row) => [row.kind, row.targetKind, row.target])).toStrictEqual([['export', 'file', 'src/lib/l.ts']]);
  });
});

// ── Program membership: a resolved file joins the program only when tsc adds it ──

/** A one-package project whose `tsconfig.json` has `options` and roots `src/index.ts`, plus `files`. */
function rootedAt(options: Record<string, unknown>, ...files: Realized[]): Realized[] {
  return [
    json('package.json', { name: 'root', type: 'module', scripts: { build: 'tsc -p tsconfig.json' } }),
    json('tsconfig.json', { compilerOptions: { ...NODENEXT, noEmit: true, types: [], ...options }, files: ['src/index.ts'] }),
    ...files,
  ];
}

/** @returns The program files of `tsconfig.json`, by path */
function programOf(rows: TsResolveRows, config = 'tsconfig.json'): string[] {
  return rows.programFiles.filter((row) => row.config === config).map((row) => row.path);
}

describe('program membership: a resolved file joins the program only when tsc adds it', () => {
  const jsChain = [
    source('src/index.ts', "export { a } from './legacy.js';"),
    source('src/legacy.js', "export { c as a } from './deep.js';"),
    source('src/deep.ts', 'export const c = 1;'),
  ];

  it('a .js target without allowJs keeps its file row and is neither a program file nor walked', async () => {
    const rows = rowsOf(await resolve(rootedAt({}, ...jsChain)));
    expect(targetsOf(rows, 'tsconfig.json', 'src/index.ts')['./legacy.js']).toMatchObject({ targetKind: 'file', target: 'src/legacy.js' });
    expect(programOf(rows)).toStrictEqual(['src/index.ts']);
    expect(rows.targets.filter((row) => row.path === 'src/legacy.js')).toStrictEqual([]);
  });

  it('the same .js target under allowJs joins the program and is walked', async () => {
    expect(programOf(rowsOf(await resolve(rootedAt({ allowJs: true }, ...jsChain))))).toStrictEqual(['src/deep.ts', 'src/index.ts', 'src/legacy.js']);
  });

  it('a .tsx target without a jsx setting keeps its file row and is not walked; with one it is', async () => {
    const files = [source('src/index.ts', "export { v } from './view.js';"), source('src/view.tsx', "export { w as v } from './w.js';"), source('src/w.ts', 'export const w = 1;')];
    const without = rowsOf(await resolve(rootedAt({}, ...files)));
    expect(targetsOf(without, 'tsconfig.json', 'src/index.ts')['./view.js']).toMatchObject({ targetKind: 'file', target: 'src/view.tsx' });
    expect(programOf(without)).toStrictEqual(['src/index.ts']);
    expect(programOf(rowsOf(await resolve(rootedAt({ jsx: 'preserve' }, ...files))))).toStrictEqual(['src/index.ts', 'src/view.tsx', 'src/w.ts']);
  });

  it('an augmentation\'s target is resolved and never added: tsc adds only the files its imports reach', async () => {
    const rows = rowsOf(await resolve(rootedAt({}, source('src/index.ts', 'export {};', "declare module './other.js' {", '  interface O { o: 1 }', '}'), source('src/other.ts', 'export interface O { p: 1 }'))));
    expect(targetsOf(rows, 'tsconfig.json', 'src/index.ts')['./other.js']).toMatchObject({ targetKind: 'file', target: 'src/other.ts' });
    expect(programOf(rows)).toStrictEqual(['src/index.ts']);
  });

  it('a file target the output map redirects from another project\'s output is a leaf: recorded, never walked under the importing config', async () => {
    const files = [
      ...pnpmWorkspace(['packages/a', 'packages/c']),
      json('packages/a/package.json', { name: 'a', type: 'module' }),
      json(A, { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, files: ['src/index.ts'] }),
      source(A_INDEX, "export { c } from '../../c/dist/index.js';"),
      json('packages/c/package.json', { name: '@acme/c', type: 'module' }),
      json('packages/c/tsconfig.json', { compilerOptions: { ...NODENEXT, outDir: 'dist', rootDir: 'src', declaration: true, types: [] }, include: ['src'] }),
      source(C_SOURCE, "export { h as c } from './helper.js';"),
      source('packages/c/src/helper.ts', 'export const h = 1;'),
    ];
    const rows = rowsOf(await resolve(files));
    expect(targetsOf(rows, A, A_INDEX)['../../c/dist/index.js']).toStrictEqual({ targetKind: 'file', target: C_SOURCE, redirected: true, mode: 'import' });
    expect(programOf(rows, A)).toStrictEqual([A_INDEX]);
    expect(rows.targets.filter((row) => row.config === A && row.path !== A_INDEX)).toStrictEqual([]);
  });
});

// ── paths under an extends chain: pathsBasePath is the directory of the config that set paths ──

describe('paths', () => {
  it('resolves an alias from the extended config\'s directory, and an alias that fails is unresolved, never external', async () => {
    const files = [
      json('package.json', { name: 'root', scripts: { build: 'tsc -p tsconfig.json' } }),
      json('tsconfig.json', { extends: './configs/tsconfig.base.json', compilerOptions: { noEmit: true, types: [] }, include: ['src'] }),
      json('configs/tsconfig.base.json', { compilerOptions: { ...NODENEXT, paths: { '@lib/*': ['../src/lib/*'] } } }),
      source('src/index.ts', "import { l } from '@lib/l.js';", "import { n } from '@lib/nope.js';", 'export { l, n };'),
      source('src/lib/l.ts', 'export const l = 1;'),
    ];
    const rows = rowsOf(await resolve(files));
    expect(rows.targets.filter((row) => row.path === 'src/index.ts').map((row) => [row.specifier, row.targetKind, row.target, row.pathsMatched])).toStrictEqual([
      ['@lib/l.js', 'file', 'src/lib/l.ts', true],
      ['@lib/nope.js', 'unresolved', null, true],
    ]);
  });
});

// ── Refusals: each refuses all three relations ──

/** A one-package project whose root file imports `src/lib/l.ts`. */
function onePackage(lib: string = 'export const l = 1;'): Realized[] {
  return [
    json('package.json', { name: 'root', scripts: { build: 'tsc -p tsconfig.json' } }),
    json('tsconfig.json', { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, files: ['src/index.ts'] }),
    source('src/index.ts', "export { l } from './lib/l.js';"),
    source('src/lib/l.ts', lib),
  ];
}

describe('refusals', () => {
  it('a reached file the ts instance does not route refuses, naming the config, the file and the remedy, read once more', async () => {
    const tsRouting = tsRoutingFor({ resources: { extractors: { ts: { exclude: ['src/lib/**'] } } } } as unknown as ProjectConfig);
    const run = await resolve(onePackage(), { tsRouting });
    expect(refusalOf(run)).toMatchObject({ code: 'DATA_REQUEST_UNROUTED', root: ROOT_ID, path: 'src/lib/l.ts', retryable: false });
    expect(refusalOf(run).message).toContain("'tsconfig.json' reaches 'src/lib/l.ts' (ts)");
    expect(refusalOf(run).remedy).toContain('remove the glob that matches it from resources.extractors.ts.exclude');
    expect(run.reads.at(-1)).toStrictEqual([{ root: ROOT_ID, path: 'src/lib/l.ts', instance: 'ts', variant: 'ts' }]);
  });

  it('a defective reached file refuses with its pair\'s code', async () => {
    const refusal = refusalOf(await resolve(onePackage('export const = ;')));
    expect(refusal).toMatchObject({ code: 'TS_PARSE_ERROR', path: 'src/lib/l.ts' });
    expect(refusal.message).toContain('has no rows this run (defective TS_PARSE_ERROR)');
  });

  it('the tsconfig family\'s refusal refuses the three relations as it stands', async () => {
    const files = [json('package.json', { name: 'root', scripts: { build: 'tsc -p tsconfig.json' } }), json('tsconfig.json', { include: ['nothing'] })];
    expect(refusalOf(await resolve(files))).toMatchObject({ code: 'TSCONFIG_PARSE_ERRORS', path: 'tsconfig.json' });
  });

  it('a package.json TypeScript reads with no rows refuses, naming it', async () => {
    const files = [...onePackage(), { path: 'src/package.json', text: '{ "type": ' }];
    expect(refusalOf(await resolve(files))).toMatchObject({ path: 'src/package.json', code: 'DATA_PARSE_ERROR' });
  });
});

// ── TS_OUTPUT_REDIRECT_AMBIGUOUS ──

describe('an output two sources build', () => {
  it('is unresolved, with one condition row naming both sources', async () => {
    const files = [
      ...pnpmWorkspace(['packages/a', 'packages/c/tsconfig.one.json', 'packages/c/tsconfig.two.json']),
      json('packages/a/package.json', { name: 'a', type: 'module', dependencies: { '@acme/c': 'workspace:*' } }),
      json(A, { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, files: ['src/index.ts'] }),
      source(A_INDEX, "export { c } from '@acme/c';"),
      json('packages/c/package.json', { name: '@acme/c', type: 'module', exports: './dist/index.js' }),
      json('packages/c/tsconfig.one.json', { compilerOptions: { ...NODENEXT, outDir: 'dist', rootDir: 'one', types: [] }, include: ['one'] }),
      json('packages/c/tsconfig.two.json', { compilerOptions: { ...NODENEXT, outDir: 'dist', rootDir: 'two', types: [] }, include: ['two'] }),
      source('packages/c/one/index.ts', 'export const c = 1;'),
      source('packages/c/two/index.ts', 'export const c = 2;'),
    ];
    const rows = rowsOf(await resolve(files));
    expect(targetsOf(rows, A, A_INDEX)['@acme/c']).toStrictEqual({ targetKind: 'unresolved', target: null, redirected: false, mode: 'import' });
    expect(rows.conditions).toStrictEqual([expect.objectContaining({ code: 'TS_OUTPUT_REDIRECT_AMBIGUOUS', config: A, path: A_INDEX, ordinal: 0 })]);
    expect(rows.conditions[0]?.message).toContain('packages/c/one/index.ts');
    expect(rows.conditions[0]?.message).toContain('packages/c/two/index.ts');
  });
});

// ── TS_VERSION_SKEW ──

describe('ts_import_conditions', () => {
  it('reports a manifest on another TypeScript major as one root-level row, the pinned major read from the module', async () => {
    const files = [
      ...pnpmWorkspace(['packages/a'], { devDependencies: { typescript: '^5.9.3' } }),
      json('packages/a/package.json', { name: 'a', devDependencies: { typescript: `^${typescript.version}` } }),
      json(A, { compilerOptions: { ...NODENEXT, noEmit: true, types: [] }, include: ['src'] }),
      source(A_INDEX, 'export {};'),
    ];
    const run = await resolve(files);
    expect(rowsOf(run).conditions).toStrictEqual([{
      root: ROOT_ID,
      config: null,
      path: null,
      ordinal: null,
      code: 'TS_VERSION_SKEW',
      message: expect.stringContaining('typescript major 5') as unknown as string,
      pinnedMajor: Number(typescript.version.split('.')[0]),
      declaredMajors: '5,6',
      manifests: 1,
    }]);
    expect(run.answer.typescript).toBe(typescript.version);
  });
});
