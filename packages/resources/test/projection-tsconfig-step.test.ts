/**
 * The tsconfig resolve step (`projection/tsconfig-step.ts`) over the data stage's declared-reads
 * handle, with the parse job run in-process (Task 4's `parseTsconfigs`): the waves, the declared
 * set, every refusal with exactly one outcome, and every `tsconfig_*` relation's rows.
 *
 * The stage runs over an in-memory fixture (`/repo`, `root-1`), store off unless an arm says so;
 * the git-content listing is the fixture's files minus the ones a test calls ignored.
 */

import { compareCodeUnits, readWorkCounters } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PARSE_LIMITS, ParseLimitError, ParseWorkerDiedError } from '../src/parse-limits.js';
import { extractDataRows, type ExtractedDataNode } from '../src/projection/data-extractor.js';
import { type DataDemand, type DataStageSeams } from '../src/projection/data-stage.js';
import { declaredReadsOver, type DeclaredPair, type DeclaredReads } from '../src/projection/declared-reads.js';
import { isStoredRowsEvicted } from '../src/projection/query-projection.js';
import { dataRoutingFor, type DataRouting } from '../src/projection/router.js';
import { runStoredReads } from '../src/projection/stored-reads.js';
import type { TsconfigJobAnswer, TsconfigJobInput } from '../src/projection/tsconfig-parse.js';
import { jsonTextOf, leavesRoot, resolveTsconfig, type TsconfigAnswer, type TsconfigRefusal, type TsconfigRows } from '../src/projection/tsconfig-step.js';
import { DEFAULT_TSCONFIG_COMPILERS } from '../src/schemas/projection-tsconfig.js';
import type ts from '../src/vendor/typescript.cjs';
import { loadVendoredTypeScript } from '../src/vendored-typescript.js';

import { FakeFactStore, WIDE_STORE_BUDGETS } from './fake-fact-store.js';
import { evictingFirstDeclaredRead, extractorOf, inProcessTsconfigParse, stage, staged, type Realized } from './helpers/data-stage-fixture.js';

const ROOT_ID = 'root-1';
const ROOT_PATH = '/repo';
const PKG = 'package.json';
const APP = 'packages/app/tsconfig.json';
const LIB = 'packages/lib/tsconfig.json';
const BASE = 'tsconfig.base.json';
const WAIVER = 'tools/test-typecheck-coverage-waiver.json';
const DATA_REQUEST_UNROUTED = 'DATA_REQUEST_UNROUTED';
const PARSE_ERRORS = 'TSCONFIG_PARSE_ERRORS';

/** Only `data__routes`: the step's reads are its own. */
const ROUTES_ONLY: DataDemand = { tables: [], routes: true, values: false, workspace: false, tsconfig: false };

let typescript: typeof ts;

beforeAll(async () => {
  typescript = await loadVendoredTypeScript();
});

/** @returns A realization holding `value` as JSON */
function json(path: string, value: unknown): Realized {
  return { path, text: `${JSON.stringify(value, null, 2)}\n` };
}

/** @returns A source file realization */
function source(path: string): Realized {
  return { path, text: 'export {};\n' };
}

/** A root package.json running `script` as its build. */
function rootPackage(scripts: Record<string, string>): Realized {
  return json(PKG, { name: 'root', scripts });
}

/** What one run of the step saw and answered. */
interface Run {
  readonly answer: TsconfigAnswer;
  /** Every job dispatched, in order. */
  readonly jobs: TsconfigJobInput[];
  /** Every declared set the step built a handle over, in order. */
  readonly declaredSets: DeclaredPair[][];
  /** Every read through the handle: the pairs read, in order. */
  readonly reads: DeclaredPair[][];
}

/** How one run is set up. */
interface RunOptions {
  readonly routing?: DataRouting;
  /** Files the run holds that are not git content. */
  readonly ignored?: readonly string[];
  readonly store?: FakeFactStore;
  readonly seams?: DataStageSeams;
  readonly extractor?: ReturnType<typeof extractorOf>;
  /** Replaces the parse job's dispatch. */
  readonly parse?: (job: TsconfigJobInput) => Promise<TsconfigJobAnswer>;
}

/** Run the stage over `files`, then the step over its handle. */
async function resolve(files: readonly Realized[], options: RunOptions = {}): Promise<Run> {
  const result = staged(await stage(files, {
    demand: ROUTES_ONLY,
    ...(options.routing === undefined ? {} : { routing: options.routing }),
    ...(options.store === undefined ? {} : { store: options.store, reads: runStoredReads() }),
    ...(options.seams === undefined ? {} : { seams: options.seams }),
    ...(options.extractor === undefined ? {} : { extractor: options.extractor }),
  }));
  const jobs: TsconfigJobInput[] = [];
  const declaredSets: DeclaredPair[][] = [];
  const reads: DeclaredPair[][] = [];
  const declaredReads = (declared: readonly DeclaredPair[]): DeclaredReads => {
    declaredSets.push([...declared]);
    const handle = result.declaredReads(declared);
    return {
      read: (pairs, request) => {
        reads.push([...pairs]);
        return handle.read(pairs, request);
      },
    };
  };
  const ignored = new Set(options.ignored ?? []);
  const answer = await resolveTsconfig({
    roots: [{ id: ROOT_ID, path: ROOT_PATH }],
    files: new Map([[ROOT_ID, new Set(files.map((file) => file.path))]]),
    declaredReads,
    gitContent: files.filter((file) => !ignored.has(file.path)).map((file) => ({ root: ROOT_ID, repository: '', path: file.path })),
    compilers: DEFAULT_TSCONFIG_COMPILERS,
    parse: options.parse ?? inProcessTsconfigParse(typescript, jobs),
  });
  return { answer, jobs, declaredSets, reads };
}

/** @returns The rows, failing on a refusal */
function rowsOf(run: Run): TsconfigRows {
  if (run.answer.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(run.answer)}`);
  return run.answer.rows;
}

/** @returns The refusal, failing on rows */
function refusalOf(run: Run): TsconfigRefusal {
  if (run.answer.outcome !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(run.answer.rows)}`);
  return run.answer.refusal;
}

/** {@link onePackage} with the app's config text replaced verbatim (to write a repeated key). */
function withAppText(text: string, extra: readonly Realized[] = []): Realized[] {
  return onePackage({}, extra).map((file) => (file.path === APP ? { path: APP, text } : file));
}

/** One package invoking its own tsconfig, which holds `config`, plus `src/index.ts`. */
function onePackage(config: Record<string, unknown>, extra: readonly Realized[] = []): Realized[] {
  return [
    rootPackage({ typecheck: 'tsc -p packages/app' }),
    json(APP, config),
    source('packages/app/src/index.ts'),
    ...extra,
  ];
}

/** The rows fixture: two packages, a reference, an extends, paths, a missing invocation and literal reaches. */
const ROWS_FIXTURE: readonly Realized[] = [
  rootPackage({ build: 'tsc -b packages/app', check: 'tsc -p tsconfig.missing.json' }),
  json('packages/app/package.json', { name: 'app', scripts: { typecheck: 'tsc --noEmit' } }),
  json(APP, {
    extends: '../../tsconfig.base.json',
    compilerOptions: { outDir: 'dist', rootDir: 'src', composite: true, paths: { '@lib/*': ['../lib/src/*', '../lib/gen/*'] } },
    include: ['src', 'docs-literal'],
    files: ['src/gen.ts'],
    references: [{ path: '../lib' }],
  }),
  json(BASE, { compilerOptions: { allowJs: true, resolveJsonModule: true, baseUrl: '.' } }),
  json(LIB, { compilerOptions: { composite: true }, include: ['src'] }),
  source('packages/app/src/index.ts'),
  source('packages/lib/src/a.ts'),
];

/** @returns The rows the data instance extracts for `text` as jsonc */
function nodesOf(text: string): readonly ExtractedDataNode[] {
  const extraction = extractDataRows({ text, variant: 'jsonc', bom: false }, DEFAULT_PARSE_LIMITS);
  if (extraction.outcome !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(extraction)}`);
  return extraction.rows.nodes;
}

describe('jsonTextOf: a config rebuilt from its rows', () => {
  it('rebuilds objects, arrays and scalars in source order, numbers as written', () => {
    const text = '{\n  // c\n  "a": [1, 2.50, -3e2, "x", true, null, {}, []],\n  "b": { "c": "d", },\n}';
    expect(JSON.parse(jsonTextOf(nodesOf(text)))).toStrictEqual({ a: [1, 2.5, -300, 'x', true, null, {}, []], b: { c: 'd' } });
    expect(jsonTextOf(nodesOf(text))).toContain('2.50');
  });

  it('keeps every occurrence of a repeated key, in source order, as TypeScript reads each one', () => {
    expect(jsonTextOf(nodesOf('{"a": {"x": 1}, "b": 2, "a": {"y": 3}}'))).toBe('{"a":{"x":1},"b":2,"a":{"y":3}}');
  });

  it('escapes strings and keys', () => {
    expect(JSON.parse(jsonTextOf(nodesOf(String.raw`{"k\"ey": "line\nnext \u0001 \\"}`)))).toStrictEqual({ 'k"ey': `line\nnext ${String.fromCodePoint(1)} \\` });
  });

  it('rebuilds a document nested past the main thread\'s comfortable recursion, without recursing', () => {
    const depth = DEFAULT_PARSE_LIMITS.outputDepth;
    const text = `${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}`;
    expect(jsonTextOf(nodesOf(text))).toBe(text);
  });

  it('answers the empty text for a file with no document', () => {
    expect(jsonTextOf([])).toBe('');
  });
});

describe('leavesRoot: a recorded path outside the analysis root', () => {
  it('is a `..` first segment, or an absolute path (another drive on Windows)', () => {
    expect(['..', '../x', '../../a/b.json', '/etc/x.json', 'C:/other/tsconfig.json', 'd:/x'].map((path) => leavesRoot(path))).toStrictEqual([true, true, true, true, true, true]);
    expect(['', 'a', '..a/b', 'a/../b', 'packages/x.json'].map((path) => leavesRoot(path))).toStrictEqual([false, false, false, false, false]);
  });
});

describe('the tsconfig_* rows', () => {
  it('answers every relation of the family from the final parse', async () => {
    const run = await resolve(ROWS_FIXTURE);
    const rows = rowsOf(run);
    expect(run.answer.typescript).toBe(typescript.version);
    expect(rows.invocations.map((row) => [row.path, row.script, row.config, row.buildMode])).toStrictEqual([
      [PKG, 'build', APP, true],
      [PKG, 'check', null, false],
      ['packages/app/package.json', 'typecheck', APP, false],
    ]);
    expect(rows.references).toStrictEqual([{ root: ROOT_ID, config: APP, ordinal: 0, spec: '../lib', path: LIB }]);
    expect(rows.closure).toStrictEqual([
      { root: ROOT_ID, config: APP, member: APP, distance: 0 },
      { root: ROOT_ID, config: APP, member: LIB, distance: 1 },
      { root: ROOT_ID, config: LIB, member: LIB, distance: 0 },
    ]);
    expect(rows.configs).toStrictEqual([
      { root: ROOT_ID, path: APP, outDir: 'packages/app/dist', rootDir: 'packages/app/src', baseUrl: '.', allowJs: true, resolveJsonModule: true, composite: true },
      { root: ROOT_ID, path: LIB, outDir: null, rootDir: null, baseUrl: null, allowJs: null, resolveJsonModule: null, composite: true },
    ]);
    expect(rows.extends).toStrictEqual([{ root: ROOT_ID, config: APP, ordinal: 0, path: BASE }]);
    expect(rows.files).toStrictEqual([
      { root: ROOT_ID, config: APP, path: 'packages/app/src/index.ts' },
      { root: ROOT_ID, config: LIB, path: 'packages/lib/src/a.ts' },
    ]);
    expect(rows.paths).toStrictEqual([
      { root: ROOT_ID, config: APP, pattern: '@lib/*', ordinal: 0, target: '../lib/src/*', basePath: '.' },
      { root: ROOT_ID, config: APP, pattern: '@lib/*', ordinal: 1, target: '../lib/gen/*', basePath: '.' },
    ]);
    expect(rows.conditions.map((row) => [row.path, row.code, row.seq, row.kind, row.reached])).toStrictEqual([
      [PKG, 'TSCONFIG_INVOKED_MISSING', 0, null, null],
      [APP, 'TSCONFIG_REACHES_OUTSIDE_GIT', 0, 'files-entry', 'packages/app/src/gen.ts'],
      [APP, 'TSCONFIG_REACHES_OUTSIDE_GIT', 1, 'include-entry', 'packages/app/docs-literal'],
    ]);
  });

  it('counts configs, waves, entries listed and reaches outside git', async () => {
    const before = readWorkCounters();
    const run = await resolve(ROWS_FIXTURE);
    const after = readWorkCounters();
    const moved = (name: keyof typeof after): number => after[name] - before[name];
    expect(moved('resolve.tsconfig.configs')).toBe(2);
    expect(moved('resolve.tsconfig.waves')).toBe(run.jobs.length);
    expect(moved('resolve.tsconfig.entriesListed')).toBe(ROWS_FIXTURE.length);
    expect(moved('resolve.tsconfig.reachesOutsideGit')).toBe(2);
  });

  it('a reference cycle terminates: each member once, at its shortest distance', async () => {
    const run = await resolve([
      rootPackage({ build: 'tsc -b packages/a' }),
      json('packages/a/tsconfig.json', { files: [], references: [{ path: '../b' }] }),
      json('packages/b/tsconfig.json', { files: [], references: [{ path: '../c' }, { path: '../a' }] }),
      json('packages/c/tsconfig.json', { files: [], references: [{ path: '../a' }] }),
    ]);
    const a = 'packages/a/tsconfig.json';
    const b = 'packages/b/tsconfig.json';
    const c = 'packages/c/tsconfig.json';
    expect(rowsOf(run).closure.map((row) => [row.config, row.member, row.distance])).toStrictEqual([
      [a, a, 0], [a, b, 1], [a, c, 2],
      [b, a, 1], [b, b, 0], [b, c, 1],
      [c, a, 1], [c, b, 2], [c, c, 0],
    ]);
  });

  it('${configDir} in a shared base resolves against each extending config', async () => {
    const rows = rowsOf(await resolve([
      rootPackage({ a: 'tsc -p packages/a', b: 'tsc -p packages/b' }),
      json('configs/tsconfig.base.json', { compilerOptions: { outDir: '${configDir}/dist' }, include: ['${configDir}/src'] }),
      json('packages/a/tsconfig.json', { extends: '../../configs/tsconfig.base.json' }),
      json('packages/b/tsconfig.json', { extends: '../../configs/tsconfig.base.json' }),
      source('packages/a/src/x.ts'),
      source('packages/b/src/y.ts'),
      source('configs/src/z.ts'),
    ]));
    expect(rows.files.map((row) => [row.config, row.path])).toStrictEqual([
      ['packages/a/tsconfig.json', 'packages/a/src/x.ts'],
      ['packages/b/tsconfig.json', 'packages/b/src/y.ts'],
    ]);
    expect(rows.configs.map((row) => row.outDir)).toStrictEqual(['packages/a/dist', 'packages/b/dist']);
  });

  it('array extends: the chain in TypeScript\'s order', async () => {
    const rows = rowsOf(await resolve(onePackage({ extends: ['../../tsconfig.one.json', '../../tsconfig.two.json'] }, [
      json('tsconfig.one.json', { extends: './tsconfig.zero.json' }),
      json('tsconfig.zero.json', {}),
      json('tsconfig.two.json', {}),
    ])));
    expect(rows.extends.map((row) => [row.ordinal, row.path])).toStrictEqual([[0, 'tsconfig.one.json'], [1, 'tsconfig.zero.json'], [2, 'tsconfig.two.json']]);
  });

  it('no invoked config: no job, no TypeScript, empty relations but the invocations', async () => {
    const run = await resolve([rootPackage({ test: 'vitest run' }), json(APP, {})]);
    expect(run.jobs).toStrictEqual([]);
    expect(run.answer.typescript).toBeNull();
    expect(rowsOf(run).configs).toStrictEqual([]);
  });
});

describe('the waves', () => {
  /** Three packages whose chains share a base three `extends` deep (each config's bytes its own, so each is its own row set). */
  const SHARED_BASE: readonly Realized[] = [
    rootPackage({ a: 'tsc -p packages/a', b: 'tsc -p packages/b', c: 'tsc -p packages/c' }),
    ...['a', 'b', 'c'].flatMap((name) => [
      json(`packages/${name}/tsconfig.json`, { extends: '../../configs/tsconfig.lib.json', compilerOptions: { outDir: `dist-${name}` } }),
      source(`packages/${name}/src/index.ts`),
    ]),
    json('configs/tsconfig.lib.json', { extends: './tsconfig.mid.json' }),
    json('configs/tsconfig.mid.json', { extends: './tsconfig.base.json' }),
    json('configs/tsconfig.base.json', { compilerOptions: { strict: true }, include: ['${configDir}/src'] }),
  ];

  it('the shared-base fixture: one wave per extends level, each config read once, no id read twice', async () => {
    const run = await resolve(SHARED_BASE);
    expect(rowsOf(run).files).toHaveLength(3);
    expect(run.jobs).toHaveLength(4);
    const read = run.reads.flat().map((pair) => `${pair.path} ${pair.variant}`);
    expect(new Set(read).size).toBe(read.length);
    expect(read.toSorted(compareCodeUnits)).toStrictEqual([
      'configs/tsconfig.base.json jsonc', 'configs/tsconfig.lib.json jsonc', 'configs/tsconfig.mid.json jsonc',
      'package.json json',
      'packages/a/tsconfig.json jsonc', 'packages/b/tsconfig.json jsonc', 'packages/c/tsconfig.json jsonc',
    ]);
    // One read per wave after the package.json read: the demanded configs, then each level.
    expect(run.reads.map((pairs) => pairs.length)).toStrictEqual([1, 3, 1, 1, 1]);
    // Only the final job carries every text; each earlier one is short exactly the next level.
    expect(Object.keys(run.jobs.at(-1)?.texts ?? {}).toSorted(compareCodeUnits)).toStrictEqual(read.filter((entry) => entry.endsWith('jsonc')).map((entry) => entry.split(' ')[0] ?? '').toSorted(compareCodeUnits));
  });

  it('store on, cold and warm: the step decodes exactly the node rows of the files it read, never one twice', async () => {
    for (const arm of ['cold', 'warm']) {
      // Each arm its own store, whose decode ledger is the run's; the warm one holds the row sets
      // from an earlier stage, so the measured stage serves them from the store.
      const store = new FakeFactStore(WIDE_STORE_BUDGETS);
      if (arm === 'warm') await stage(SHARED_BASE, { demand: ROUTES_ONLY, store, reads: runStoredReads() });
      const served = readWorkCounters()['rowSet.storeServed'];
      const result = staged(await stage(SHARED_BASE, { demand: ROUTES_ONLY, store, reads: runStoredReads() }));
      expect(readWorkCounters()['rowSet.storeServed'] - served, arm).toBe(arm === 'warm' ? SHARED_BASE.filter((file) => file.path.endsWith('.json')).length : 0);
      const before = readWorkCounters();
      const answer = await resolveTsconfig({
        roots: [{ id: ROOT_ID, path: ROOT_PATH }],
        files: new Map([[ROOT_ID, new Set(SHARED_BASE.map((file) => file.path))]]),
        declaredReads: result.declaredReads,
        gitContent: SHARED_BASE.map((file) => ({ root: ROOT_ID, repository: '', path: file.path })),
        compilers: DEFAULT_TSCONFIG_COMPILERS,
        parse: inProcessTsconfigParse(typescript),
      });
      const after = readWorkCounters();
      expect(answer.outcome, arm).toBe('rows');
      const readFiles = SHARED_BASE.filter((file) => file.path.endsWith('.json'));
      const nodes = readFiles.reduce((sum, file) => {
        const extraction = extractDataRows({ text: file.text ?? '', variant: file.path === PKG ? 'json' : 'jsonc', bom: false }, DEFAULT_PARSE_LIMITS);
        return sum + (extraction.outcome === 'rows' ? extraction.rows.nodes.length : Number.NaN);
      }, 0);
      expect(after['rowSet.rows.decoded'] - before['rowSet.rows.decoded'], arm).toBe(nodes);
      expect(after['store.rows.decoded.repeated'] - before['store.rows.decoded.repeated'], arm).toBe(0);
    }
  });

  it.each([
    ['a parse limit', () => new ParseLimitError('timeMs', 30_000)],
    ['a worker that died holding the job', () => new ParseWorkerDiedError({ exitCode: 134 })],
  ])('%s refuses the family retryably under the error\'s own code', async (_name, fail) => {
    const run = await resolve(onePackage({}), { parse: () => Promise.reject(fail()) });
    expect(refusalOf(run)).toMatchObject({ code: fail().code, retryable: true });
  });

  it('basePath is baseUrl when set, else the directory of the config that set paths (TypeScript\'s getPathsBasePath)', async () => {
    const paths = { '@/*': ['*'] };
    const withBase = rowsOf(await resolve(onePackage({ compilerOptions: { baseUrl: './src', paths, ignoreDeprecations: '6.0' } })));
    const without = rowsOf(await resolve(onePackage({ compilerOptions: { paths } })));
    expect([withBase.paths[0]?.basePath, without.paths[0]?.basePath]).toStrictEqual(['packages/app/src', 'packages/app']);
  });

  it('reads a repeated compilerOptions key as TypeScript does: the earlier one still sets its options', async () => {
    const run = await resolve(withAppText('{"compilerOptions":{"outDir":"out"},"compilerOptions":{"strict":true}}'));
    expect(rowsOf(run).configs.map((row) => row.outDir)).toStrictEqual(['packages/app/out']);
  });

  it('reads a shadowed extends: one outside the root still refuses TSCONFIG_EXTENDS_OUTSIDE_ROOT', async () => {
    const run = await resolve(withAppText('{"extends":"../../../shared/tsconfig.json","extends":"../../tsconfig.json"}', [json('tsconfig.json', {})]));
    expect(refusalOf(run)).toMatchObject({ code: 'TSCONFIG_EXTENDS_OUTSIDE_ROOT', path: APP });
  });

  it('serves TypeScript\'s package scope lookup from the package.json rows it already read, with no second read', async () => {
    const run = await resolve(onePackage({ extends: '@tsconfig/node20/tsconfig.json' }));
    expect(refusalOf(run)).toMatchObject({ code: PARSE_ERRORS, path: APP, retryable: false });
    expect(refusalOf(run).message).toContain('TS6053');
    expect(run.jobs.at(-1)?.texts[PKG]).toBeDefined();
    expect(run.reads.flat().filter((pair) => pair.path === PKG)).toHaveLength(1);
  });

  it('terminates when TypeScript asks for a package.json the step cannot serve: it refuses', async () => {
    // The config's directory holds no package.json, so the scope lookup walks up to the root's,
    // which is excluded; the invoking package.json is another.
    const run = await resolve([
      json(PKG, { name: 'root' }),
      json('packages/app/package.json', { name: 'app', scripts: { typecheck: 'tsc -p ../../configs/tsconfig.json' } }),
      json('configs/tsconfig.json', { extends: '@tsconfig/node20/tsconfig.json', files: ['../packages/app/src/index.ts'] }),
      source('packages/app/src/index.ts'),
    ], {
      routing: dataRoutingFor({ resources: { extractors: { data: { exclude: [PKG] } } } }),
    });
    expect(refusalOf(run)).toMatchObject({ code: DATA_REQUEST_UNROUTED, path: PKG, retryable: false });
    expect(run.jobs.length).toBeLessThanOrEqual(2);
  });
});

describe('the declared set', () => {
  /** The routing: the waiver file routed as json (an include), so it is routed, and not as jsonc. */
  const ROUTED_WAIVER = dataRoutingFor({ resources: { extractors: { data: { include: ['tools/*.json'] } } } });

  it('an undeclared pair throws naming the id, even when routed: the waiver file as jsonc, a demanded config as json', async () => {
    const files = [...onePackage({}), json(WAIVER, { uncovered: [] })];
    const run = await resolve(files, { routing: ROUTED_WAIVER });
    expect(rowsOf(run).configs).toHaveLength(1);
    const declared = run.declaredSets.at(-1) ?? [];
    expect(declared).toContainEqual({ root: ROOT_ID, path: APP, variant: 'jsonc' });
    expect(declared).toContainEqual({ root: ROOT_ID, path: PKG, variant: 'json' });
    const result = staged(await stage(files, { demand: ROUTES_ONLY, routing: ROUTED_WAIVER }));
    const handle = result.declaredReads(declared);
    await expect(handle.read([{ root: ROOT_ID, path: WAIVER, variant: 'jsonc' }], { tables: ['dataNodes'] })).rejects.toThrow(/test-typecheck-coverage-waiver\.json.*not declared/u);
    await expect(handle.read([{ root: ROOT_ID, path: APP, variant: 'json' }], { tables: ['dataNodes'] })).rejects.toThrow(/packages\/app\/tsconfig\.json.*not declared/u);
    // The same handle over the run's routes reads the declared pairs.
    const direct = declaredReadsOver(declared, { routing: ROUTED_WAIVER, routes: result.derived.dataRoutes ?? [], read: () => Promise.resolve({ dataNodes: [] }) as never });
    await expect(direct.read([{ root: ROOT_ID, path: WAIVER, variant: 'jsonc' }], { tables: ['dataNodes'] })).rejects.toThrow(/not declared/u);
  });

  it('declares the json pair of every package.json the run holds outside node_modules, and no other json pair', async () => {
    const run = await resolve([...onePackage({}), json('packages/app/package.json', { name: 'app' }), json('node_modules/x/package.json', { name: 'x' })]);
    rowsOf(run);
    const json_ = (run.declaredSets.at(-1) ?? []).filter((pair) => pair.variant === 'json').map((pair) => pair.path);
    expect(json_.toSorted(compareCodeUnits)).toStrictEqual([PKG, 'packages/app/package.json']);
  });
});

/** @returns The refusal of a run over `files` */
async function refused(files: readonly Realized[], options: RunOptions = {}): Promise<TsconfigRefusal> {
  return refusalOf(await resolve(files, options));
}

describe('refusals, each with exactly one outcome', () => {
  it('an extends target that is git content but unrouted: DATA_REQUEST_UNROUTED naming the extending config, the target and the reason', async () => {
    const refusal = await refused(onePackage({ extends: '../../shared/base.json' }, [json('shared/base.json', {})]));
    expect(refusal).toMatchObject({ code: DATA_REQUEST_UNROUTED, path: APP, retryable: false });
    expect(refusal.message).toContain('shared/base.json');
    expect(refusal.message).toMatch(/no rule of resources\.extractors\.data routes it/u);
    expect(refusal.remedy).toMatch(/resources\.extractors\.data as jsonc/u);
  });

  it('an extends target that is excluded: DATA_REQUEST_UNROUTED, reason excluded', async () => {
    const refusal = await refused(onePackage({ extends: '../../configs/tsconfig.base.json' }, [json('configs/tsconfig.base.json', {})]), {
      routing: dataRoutingFor({ resources: { extractors: { data: { exclude: ['configs/**'] } } } }),
    });
    expect(refusal).toMatchObject({ code: DATA_REQUEST_UNROUTED, path: APP });
    expect(refusal.message).toContain('configs/tsconfig.base.json');
    expect(refusal.message).toMatch(/exclude routes it away/u);
  });

  it('an extends target that is gitignored, one inside node_modules, and a package name: TSCONFIG_PARSE_ERRORS, never outside the root', async () => {
    const ignored = await refused(onePackage({ extends: '../../configs/tsconfig.base.json' }, [json('configs/tsconfig.base.json', {})]), { ignored: ['configs/tsconfig.base.json'] });
    const nodeModules = await refused(onePackage({ extends: '../../node_modules/x/tsconfig' }));
    const packageName = await refused(onePackage({ extends: '@scope/config/tsconfig.json' }));
    for (const refusal of [ignored, nodeModules, packageName]) expect(refusal).toMatchObject({ code: PARSE_ERRORS, path: APP, retryable: false });
    expect(ignored.message).toMatch(/TS5083/u);
    expect(nodeModules.message).toMatch(/TS6053/u);
    expect(packageName.message).toMatch(/TS6053/u);
  });

  it('a relative extends above the root, through an ancestor\'s node_modules: TSCONFIG_EXTENDS_OUTSIDE_ROOT, not a probe', async () => {
    const refusal = await refused(onePackage({ extends: '../../../node_modules/@tsconfig/strictest/tsconfig.json' }));
    expect(refusal).toMatchObject({ code: 'TSCONFIG_EXTENDS_OUTSIDE_ROOT', path: APP });
  });

  it('TS18003, whatever its cause: a non-existent include directory, and ignored-only inputs', async () => {
    const missing = await refused(onePackage({ include: ['nothing-here'] }));
    const ignoredOnly = await refused(onePackage({ include: ['gen'] }, [source('packages/app/gen/a.ts')]), { ignored: ['packages/app/gen/a.ts'] });
    for (const refusal of [missing, ignoredOnly]) {
      expect(refusal).toMatchObject({ code: PARSE_ERRORS, path: APP });
      expect(refusal.message).toMatch(/TS18003/u);
    }
  });

  it('an extends outside the root: TSCONFIG_EXTENDS_OUTSIDE_ROOT, with the analysis-root remedy', async () => {
    const refusal = await refused(onePackage({ extends: '../../../shared/tsconfig.json' }));
    expect(refusal).toMatchObject({ code: 'TSCONFIG_EXTENDS_OUTSIDE_ROOT', path: APP, retryable: false });
    expect(refusal.message).toContain('../shared/tsconfig.json');
    expect(refusal.remedy).toMatch(/vibe-agent-toolkit\.config\.yaml/u);
    expect(refusal.remedy).toMatch(/git root/u);
  });

  it('an include outside the root: TSCONFIG_INPUTS_OUTSIDE_ROOT (and not TS18003, which it also causes)', async () => {
    const refusal = await refused(onePackage({ include: ['../../../shared/**/*'] }));
    expect(refusal).toMatchObject({ code: 'TSCONFIG_INPUTS_OUTSIDE_ROOT', path: APP });
    expect(refusal.message).toContain('../shared');
  });

  it('a reference outside the root: TSCONFIG_REFERENCE_OUTSIDE_ROOT', async () => {
    const refusal = await refused(onePackage({ references: [{ path: '../../../other' }] }));
    expect(refusal).toMatchObject({ code: 'TSCONFIG_REFERENCE_OUTSIDE_ROOT', path: APP });
    expect(refusal.message).toContain('../other');
  });

  it('a -p outside the root: TSCONFIG_INVOKED_OUTSIDE_ROOT, before any job', async () => {
    const run = await resolve([rootPackage({ build: 'tsc -p ../elsewhere/tsconfig.json' })]);
    expect(refusalOf(run)).toMatchObject({ code: 'TSCONFIG_INVOKED_OUTSIDE_ROOT', path: PKG });
    expect(refusalOf(run).message).toContain('../elsewhere/tsconfig.json');
    expect(run.jobs).toStrictEqual([]);
  });

  it('a defective demanded config refuses naming its pair code; a refused one is retryable', async () => {
    const defective = await refused(onePackage({}).map((file) => (file.path === APP ? { path: APP, text: '{' } : file)));
    expect(defective).toMatchObject({ code: 'DATA_PARSE_ERROR', path: APP, retryable: false });
    const timedOut = await refused(onePackage({}), {
      extractor: extractorOf((variant) => (variant === 'jsonc' ? new ParseLimitError('timeMs', DEFAULT_PARSE_LIMITS.timeMs, DEFAULT_PARSE_LIMITS.timeMs + 1) : undefined)),
    });
    expect(timedOut).toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED', path: APP, retryable: true });
  });

  it('a defective extends target refuses at the extending config, naming the target', async () => {
    const refusal = await refused(onePackage({ extends: '../../tsconfig.base.json' }, [{ path: BASE, text: '{"a": ' }]));
    expect(refusal).toMatchObject({ code: 'DATA_PARSE_ERROR', path: APP });
    expect(refusal.message).toContain(BASE);
  });

  it('a reference to a config that is not git content refuses TSCONFIG_PARSE_ERRORS naming it, whether absent or ignored, and never reads an ignored one', async () => {
    const absent = await refused(onePackage({ references: [{ path: '../gone' }] }));
    const ignored = await resolve(onePackage({ references: [{ path: '../gen' }] }, [json('packages/gen/tsconfig.json', {})]), { ignored: ['packages/gen/tsconfig.json'] });
    expect(absent).toMatchObject({ code: PARSE_ERRORS, path: APP });
    expect(absent.message).toContain('packages/gone/tsconfig.json');
    expect(refusalOf(ignored)).toMatchObject({ code: PARSE_ERRORS, path: APP });
    expect(refusalOf(ignored).message).toContain('not git content');
    expect(ignored.reads.flat().map((pair) => pair.path)).not.toContain('packages/gen/tsconfig.json');
  });

  it('store on: a row set evicted before a declared read throws the row-set eviction for the lane to retry', async () => {
    const store = new FakeFactStore(WIDE_STORE_BUDGETS);
    const seams = evictingFirstDeclaredRead(store);
    const error = await resolve(onePackage({}), { store, seams }).catch((caught: unknown) => caught);
    expect(isStoredRowsEvicted(error)).toBe(true);
  });
});

/** TypeScript's diagnostic message table: internal, mutable, read by every diagnostic it builds. */
interface DiagnosticTable {
  readonly Diagnostics: Record<string, { message: string }>;
  createCompilerDiagnostic(message: { message: string }, ...args: string[]): { messageText: string };
}

describe('classification never reads TypeScript\'s diagnostic text', () => {
  /** A config per refusal the job's answer decides: three outside the root, two parse errors. */
  const CASES: ReadonlyArray<readonly Realized[]> = [
    onePackage({ extends: '../../../shared/tsconfig.json' }),
    onePackage({ include: ['../../../shared/**/*'] }),
    onePackage({ references: [{ path: '../../../other' }] }),
    onePackage({ extends: '@scope/config/tsconfig.json' }),
    onePackage({ include: ['nothing-here'] }),
  ];

  // The job carries no message text (an error is a code and a category), so no seam in the step can
  // replace it: the seam is TypeScript's own table, every message set to one constant while the
  // same parses run. Red if anything downstream of the parse classified by a message's wording.
  it('every refusal is the same with every TypeScript diagnostic message replaced by a constant', async () => {
    const CONSTANT = 'constant diagnostic text';
    const table = typescript as unknown as DiagnosticTable;
    const before = await mapRefusals(CASES);
    const saved = Object.values(table.Diagnostics).map((entry) => [entry, entry.message] as const);
    for (const [entry] of saved) entry.message = CONSTANT;
    try {
      // Positive control: a diagnostic TypeScript builds now says the constant.
      expect(table.createCompilerDiagnostic(table.Diagnostics['File_0_not_found'] ?? { message: '' }, 'x').messageText).toBe(CONSTANT);
      expect(await mapRefusals(CASES)).toStrictEqual(before);
    } finally {
      for (const [entry, message] of saved) entry.message = message;
    }
    expect(before.map((refusal) => refusal.code)).toStrictEqual(['TSCONFIG_EXTENDS_OUTSIDE_ROOT', 'TSCONFIG_INPUTS_OUTSIDE_ROOT', 'TSCONFIG_REFERENCE_OUTSIDE_ROOT', PARSE_ERRORS, PARSE_ERRORS]);
  });
});

/** @returns Each case's refusal, in order */
async function mapRefusals(cases: ReadonlyArray<readonly Realized[]>): Promise<TsconfigRefusal[]> {
  const refusals: TsconfigRefusal[] = [];
  for (const files of cases) refusals.push(refusalOf(await resolve(files)));
  return refusals;
}
