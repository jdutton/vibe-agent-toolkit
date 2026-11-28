/**
 * Where TypeScript runs.
 *
 * **The thread hook.** The vendored module's parsing entry points (`createSourceFile`,
 * `parseJsonText`, `parseJsonSourceFileConfigFileContent`, `parseJsonConfigFileContent`,
 * `matchFiles`, `createScanner`) are wrapped, in a test only, on both sides of a real run:
 *
 * - the stage's thread: the loader (`vendored-typescript.ts`) is mocked to hand back the wrapped
 *   module, so the resolve step takes it through the seam it always takes TypeScript by;
 * - the parse worker: the pool's seeded worker entry (`__setParseWorkerEntryForTest`) wraps the
 *   vendored file in that thread and redirects the built loader's `import()` of it to the wrapped
 *   module with a module load hook, then runs the built worker unchanged.
 *
 * The stage then runs over the resolved-import-graph corpus (store off, so every `ts` pair and every
 * config is parsed) once demanding the three resolved-import relations and once demanding the `tsconfig_*`
 * family. The stage's thread may call only `createSourceFile`, and only over a stand-in (a text of
 * the closed template set, `standInTexts()`); everything over document bytes is the worker's. Both
 * hooks are positive-controlled (each must record calls in the run that should make them), and a
 * seeded variant that parses documents on the stage's thread (the in-thread extractor and tsconfig
 * parse) is red.
 *
 * **The `exports` depth.** Resolution on the main thread walks a served `package.json`'s `exports`
 * recursively. A spawned plain-node process resolves through the real host, serving `exports` nested
 * from `outputDepth` (read from `DEFAULT_PARSE_LIMITS`) by doubling until the main thread overflows;
 * twice `outputDepth` must resolve. A smaller stack (derived from the measured overflow) is the red
 * seed: the verdict names the remedy, a served-depth cap.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { DEFAULT_PARSE_LIMITS } from '../../src/parse-limits.js';
import { __setParseWorkerEntryForTest, createParsePool, type ParsePool } from '../../src/parse-pool.js';
import { rowSetDemandOf, type DataStageResult } from '../../src/projection/data-stage.js';
import { allDerivedSpecs } from '../../src/projection/derived-table-registry.js';
import type { RowSetExtractor } from '../../src/projection/row-set-instances.js';
import { standInTexts } from '../../src/projection/ts-stand-ins.js';
import { DEFAULT_TSCONFIG_COMPILERS } from '../../src/schemas/projection-tsconfig.js';
import type ts from '../../src/vendor/typescript.cjs';
import * as VendoredLoader from '../../src/vendored-typescript.js';
import { extractorOf, inProcessTsconfigParse, stage, staged, type Realized } from '../helpers/data-stage-fixture.js';
// The resolved import graph's I0 workspace; the CLI arms add their config and markdown to it.
import { TS_RESOLVE_WORKSPACE } from '../helpers/ts-resolve-corpus.js';

/** One call the hook saw: the function, the thread, and the text it was handed (when it takes one). */
interface HookedCall {
  readonly fn: string;
  readonly thread: number;
  readonly text: string | null;
}

/**
 * The hook, self-contained (it is stringified into the seeded worker entry): a module whose
 * `hooked` functions record each call, its every other member the original's.
 *
 * @param original - The vendored module
 * @param hooked - The functions to wrap
 * @param record - Where a call goes: the function, and the text argument it was handed or null
 * @returns The wrapped module
 */
function wrapTypeScript(original: object, hooked: readonly string[], record: (fn: string, text: string | null) => void): object {
  // The argument each function takes its text at: the source of a file, a JSON document, a scanner's text.
  const textAt: Readonly<Record<string, number>> = { createSourceFile: 1, parseJsonText: 1, createScanner: 3 };
  const members: PropertyDescriptorMap = {};
  for (const name of hooked) {
    const fn = (original as Record<string, (...args: unknown[]) => unknown>)[name];
    if (typeof fn !== 'function') throw new TypeError(`the vendored TypeScript has no ${name}`);
    const at = textAt[name];
    members[name] = {
      value: (...args: unknown[]): unknown => {
        const text = at === undefined ? null : args[at];
        record(name, typeof text === 'string' ? text : null);
        return fn(...args);
      },
    };
  }
  return Object.create(original, members) as object;
}

/** Every entry point that parses text or walks a listing. */
const HOOKED = ['createSourceFile', 'parseJsonText', 'parseJsonSourceFileConfigFileContent', 'parseJsonConfigFileContent', 'matchFiles', 'createScanner'] as const;

/** The stage thread's calls, and how many times its loader was asked (hoisted: the mock below reads them). */
const stageThread = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; thread: number; text: string | null }>, loads: 0 }));

vi.mock('../../src/vendored-typescript.js', async (importOriginal) => {
  const original = await importOriginal<typeof VendoredLoader>();
  const { threadId: stageThreadId } = await import('node:worker_threads');
  let wrapped: Promise<typeof ts> | undefined;
  return {
    ...original,
    loadVendoredTypeScript: (): Promise<typeof ts> => {
      stageThread.loads += 1;
      wrapped ??= original.loadVendoredTypeScript().then((module) => wrapTypeScript(module, HOOKED, (fn, text) => {
        stageThread.calls.push({ fn, thread: stageThreadId, text });
      }) as typeof ts);
      return wrapped;
    },
  };
});

const PACKAGE_DIR = safePath.resolve(import.meta.dirname, '../..');
/** The built worker and the vendored file it loads, both under `dist`: a worker always runs the build. */
const BUILT_WORKER = pathToFileURL(safePath.join(PACKAGE_DIR, 'dist/parse-worker.js')).href;
const BUILT_VENDORED = safePath.join(PACKAGE_DIR, 'dist/vendor/typescript.cjs');

let scratch = '';
/** The worker's calls, one JSON line each (a worker thread's memory is not the test's). */
let workerLog = '';

beforeAll(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ts-thread-hook-'));
  workerLog = safePath.join(scratch, 'worker-calls.jsonl');
  const entry = safePath.join(scratch, 'hooked-worker.mjs');
  writeFileSync(entry, [
    "import { appendFileSync } from 'node:fs';",
    "import { createRequire, registerHooks } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "import { threadId } from 'node:worker_threads';",
    `const vendored = ${JSON.stringify(BUILT_VENDORED)};`,
    `const log = ${JSON.stringify(workerLog)};`,
    `const wrap = (${String(wrapTypeScript)});`,
    // The text's length only: what the worker parses is document bytes by design, and only its thread matters.
    `globalThis.__vatThreadHookTypeScript = wrap(createRequire(import.meta.url)(vendored), ${JSON.stringify(HOOKED)}, (fn, text) => {`,
    String.raw`  appendFileSync(log, JSON.stringify({ fn, thread: threadId, text: text === null ? null : String(text.length) }) + '\n');`,
    '});',
    'const url = pathToFileURL(vendored).href;',
    'registerHooks({',
    "  load: (specifier, context, next) => (specifier === url ? { format: 'module', source: 'export default globalThis.__vatThreadHookTypeScript;', shortCircuit: true } : next(specifier, context)),",
    '});',
    `await import(${JSON.stringify(BUILT_WORKER)});`,
  ].join('\n'), 'utf-8');
  __setParseWorkerEntryForTest(entry);
});

afterAll(() => {
  __setParseWorkerEntryForTest(null);
  rmSync(scratch, { recursive: true, force: true });
});

const pools: ParsePool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map(async (pool) => pool.shutdown()));
  stageThread.calls.length = 0;
  stageThread.loads = 0;
  writeFileSync(workerLog, '');
});

/** The corpus as the in-memory stage fixture holds it: every committed file, every one git content. */
const CORPUS: readonly Realized[] = Object.entries(TS_RESOLVE_WORKSPACE).map(([path, text]) => ({ path, text }));
const GIT_CONTENT = CORPUS.map((file) => ({ root: 'root-1', repository: '', path: file.path }));

/** The relation names a producer fills. */
function relationsOf(producer: string): ReadonlySet<string> {
  return new Set(allDerivedSpecs().filter((spec) => spec.producer === producer).map((spec) => spec.name));
}

/** A run's extraction and tsconfig parse on a real pool (one thread, the hooked entry). */
function onPool(): { extractor: RowSetExtractor; parse: NonNullable<Parameters<typeof stage>[1]>['tsconfig'] } {
  const pool = createParsePool({ size: 1 });
  pools.push(pool);
  return {
    extractor: {
      dataRows: (variant, input) => pool.dataRows(variant, input.content, input.byteLength, input.decoding.encodingSource === 'bom'),
      tsRows: (variant, input) => pool.tsRows(variant, input.content, input.byteLength),
    },
    parse: { gitContent: GIT_CONTENT, compilers: DEFAULT_TSCONFIG_COMPILERS, parse: (job) => pool.tsconfig(job) },
  };
}

/** Run the stage over the corpus, store off, demanding `producer`'s relations. */
async function run(producer: 'tsResolve' | 'tsconfig', where: { extractor: RowSetExtractor; parse: NonNullable<Parameters<typeof stage>[1]>['tsconfig'] }): Promise<Extract<DataStageResult, { outcome: 'staged' }>> {
  const demand = rowSetDemandOf(relationsOf(producer));
  if (demand === undefined) throw new Error(`no demand for ${producer}`);
  return staged(await stage(CORPUS, { demand, extractor: where.extractor, ...(where.parse === undefined ? {} : { tsconfig: where.parse }) }));
}

/** The worker's calls, read back. */
function workerCalls(): HookedCall[] {
  return readFileSync(workerLog, 'utf-8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as HookedCall);
}

/** The calls the stage's thread may not make: anything but a `createSourceFile` over a stand-in, or any call on another thread. */
function strayStageCalls(calls: readonly HookedCall[]): HookedCall[] {
  const standIns = standInTexts();
  return calls.filter((call) => call.thread !== threadId || call.fn !== 'createSourceFile' || call.text === null || !standIns.has(call.text));
}

/** The functions a list of calls reached. */
const functionsOf = (calls: readonly HookedCall[]): string[] => [...new Set(calls.map((call) => call.fn))].toSorted((left, right) => left.localeCompare(right));

describe('the thread hook over a full run (integration)', () => {
  it('a run naming the resolved-import relations calls TypeScript on the stage thread over stand-ins only; every document parse is in the worker', async () => {
    const result = await run('tsResolve', onPool());

    // The run did the work: the corpus resolves (the corpus census holds the rows; here, that there are some).
    expect(result.tsResolve?.outcome, JSON.stringify(result.tsResolve)).toBe('rows');
    if (result.tsResolve?.outcome !== 'rows') return;
    expect(result.tsResolve.rows.targets.length).toBeGreaterThan(0);

    // Positive control, stage thread: the hook is installed and saw the stand-ins.
    expect(stageThread.loads).toBeGreaterThan(0);
    expect(stageThread.calls.length).toBeGreaterThan(0);
    expect(strayStageCalls(stageThread.calls)).toEqual([]);

    // Positive control, worker: the hook saw the `ts` extraction and the tsconfig parse, on another thread.
    const worker = workerCalls();
    expect(functionsOf(worker)).toEqual(['createScanner', 'createSourceFile', 'matchFiles', 'parseJsonSourceFileConfigFileContent', 'parseJsonText']);
    expect(worker.filter((call) => call.thread === threadId)).toEqual([]);
  });

  it('a tsconfig_* run calls TypeScript in the worker only, and never loads it on the stage thread', async () => {
    const result = await run('tsconfig', onPool());

    expect(result.tsconfig?.outcome, JSON.stringify(result.tsconfig)).toBe('rows');
    expect(stageThread.loads).toBe(0);
    expect(stageThread.calls).toEqual([]);

    const worker = workerCalls();
    expect(functionsOf(worker)).toEqual(['matchFiles', 'parseJsonSourceFileConfigFileContent', 'parseJsonText']);
    expect(worker.filter((call) => call.thread === threadId)).toEqual([]);
  });

  it('red: a run that parses documents on the stage thread is caught, naming what it parsed', async () => {
    // The seeded variant: the `ts` extraction and the tsconfig parse in-thread, through the same
    // loader the step takes TypeScript from, so each document text reaches the stage thread's hook.
    const typescript = await VendoredLoader.loadVendoredTypeScript();
    await run('tsResolve', {
      extractor: extractorOf(),
      parse: { gitContent: GIT_CONTENT, compilers: DEFAULT_TSCONFIG_COMPILERS, parse: inProcessTsconfigParse(typescript) },
    });

    const stray = strayStageCalls(stageThread.calls);
    expect(functionsOf(stray)).toEqual(expect.arrayContaining(['createSourceFile', 'parseJsonText']));
    const corpusTexts = new Set(Object.values(TS_RESOLVE_WORKSPACE));
    expect(stray.some((call) => call.fn === 'createSourceFile' && call.text !== null && corpusTexts.has(call.text)), 'a document parsed on the stage thread').toBe(true);
    expect(workerCalls()).toEqual([]);
  });
});

// ── The `exports` depth ─────────────────────────────────────────────────────

/** V8's default `--stack-size` on 64-bit Node, in KiB (an external fact): the base the red seed's smaller stack is derived from. */
const NODE_DEFAULT_STACK_KIB = 984;

/** The most the probe doubles to, as a multiple of `outputDepth`, before it reports no overflow. */
const PROBE_CEILING = 64;

/** One depth the probe tried, and how the resolution ended. */
interface DepthOutcome {
  readonly depth: number;
  readonly outcome: 'resolved' | 'unresolved' | 'overflow';
}

/**
 * The probe, a plain-node ESM script: through the BUILT host (`ts-resolve-host.ts`), `@acme/app`
 * resolves `@acme/deep`, whose served `package.json` nests its `exports` `depth` levels (objects of
 * `default`, or arrays), doubling from `outputDepth` until the resolution overflows the main thread.
 * One process per shape: the overflow depth is not stable within one process.
 */
const PROBE = String.raw`
const [dist, shape, start, ceiling] = process.argv.slice(1);
const { pathToFileURL } = await import('node:url');
const at = (file) => import(pathToFileURL(dist + '/' + file).href);
const ts = await (await at('vendored-typescript.js')).loadVendoredTypeScript();
const { resolveHost } = await at('projection/ts-resolve-host.js');
const { OutputMaps } = await at('projection/ts-output-map.js');
const { workspaceLinks } = await at('projection/workspace-links.js');
const pkg = (dir, name) => ({ root: 'r', path: dir === '.' ? 'package.json' : dir + '/package.json', dir, name, version: null, private: null, workspaceRoot: dir === '.' });
const links = workspaceLinks([pkg('.', 'root'), pkg('packages/app', '@acme/app'), pkg('packages/deep', '@acme/deep')],
  [{ root: 'r', path: 'packages/app/package.json', field: 'dependencies', name: '@acme/deep', range: 'workspace:*', targetPath: 'packages/deep/package.json', protocol: 'workspace' }], false);
const outputs = new OutputMaps(ts, false, (name) => new Error(name)).combined([]);
const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const nested = (depth) => shape === 'arrays'
  ? '['.repeat(depth) + '"./index.js"' + ']'.repeat(depth)
  : '{"default":'.repeat(depth) + '"./index.js"' + '}'.repeat(depth);
const outcomes = [];
for (let depth = Number(start); depth <= Number(start) * Number(ceiling); depth *= 2) {
  const texts = {
    'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
    'packages/app/package.json': '{"name":"@acme/app","type":"module","dependencies":{"@acme/deep":"workspace:*"}}',
    'packages/deep/package.json': '{"name":"@acme/deep","type":"module","exports":{".":' + nested(depth) + '}}',
  };
  const host = resolveHost({ root: '/r', listing: [...Object.keys(texts), 'packages/app/src/a.ts', 'packages/deep/index.d.ts'], links, outputs,
    packageJsonText: (path) => texts[path], useCaseSensitiveFileNames: true });
  let outcome;
  try {
    const resolved = ts.resolveModuleName('@acme/deep', '/r/packages/app/src/a.ts', options, host).resolvedModule;
    outcome = resolved?.resolvedFileName === '/r/packages/deep/index.d.ts' ? 'resolved' : 'unresolved';
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    outcome = 'overflow';
  }
  outcomes.push({ depth, outcome });
  if (outcome !== 'resolved') break;
}
process.stdout.write(JSON.stringify(outcomes));`;

/**
 * @param shape - How `exports` nests
 * @param stackKib - A `--stack-size` for the probe, or undefined for Node's own
 * @returns What each depth the probe tried came to
 */
function probeDepths(shape: 'objects' | 'arrays', stackKib?: number): DepthOutcome[] {
  const flags = stackKib === undefined ? [] : [`--stack-size=${String(stackKib)}`];
  const result = spawnSync(NODE_EXECUTABLE, [...flags, '--input-type=module', '-e', PROBE, safePath.join(PACKAGE_DIR, 'dist'), shape, String(DEFAULT_PARSE_LIMITS.outputDepth), String(PROBE_CEILING)], {
    encoding: 'utf-8',
    timeout: inject('tierTestTimeout'),
  });
  expect(result.signal, `the probe was killed\n${result.stderr}`).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as DepthOutcome[];
}

/**
 * Whether the main thread has the margin the served `exports` walk needs: every depth up to twice
 * `outputDepth` resolves to the file the innermost target names.
 *
 * @param outcomes - The probe's depths
 * @returns The failure, naming the remedy, or undefined when the margin holds
 */
function depthVerdict(outcomes: readonly DepthOutcome[]): string | undefined {
  const need = DEFAULT_PARSE_LIMITS.outputDepth * 2;
  const short = outcomes.find((entry) => entry.depth <= need && entry.outcome !== 'resolved');
  if (short === undefined && outcomes.some((entry) => entry.depth >= need)) return undefined;
  const found = short === undefined ? 'the probe never reached it' : `exports nested ${String(short.depth)} deep came to ${short.outcome}`;
  return `the main thread cannot walk a served package.json's exports to twice outputDepth (${String(need)}): ${found}. ` +
    'Remedy: a served-depth cap, refusing a package.json the host serves when it nests past a depth derived from outputDepth.';
}

describe('the exports depth on the main thread (integration)', () => {
  for (const shape of ['objects', 'arrays'] as const) {
    it(`twice outputDepth of ${shape} resolves on a plain-node main thread; a smaller stack is red, naming the remedy`, () => {
      const outcomes = probeDepths(shape);
      expect(depthVerdict(outcomes)).toBeUndefined();

      // The red seed: a stack the measured overflow says overflows below the need (or a 64th of
      // Node's when nothing overflowed up to the ceiling).
      const overflow = outcomes.find((entry) => entry.outcome === 'overflow')?.depth ?? DEFAULT_PARSE_LIMITS.outputDepth * PROBE_CEILING;
      const smaller = Math.max(1, Math.floor((NODE_DEFAULT_STACK_KIB * DEFAULT_PARSE_LIMITS.outputDepth) / (2 * overflow)));
      const red = probeDepths(shape, smaller);
      expect(red.at(-1)?.outcome, JSON.stringify(red)).toBe('overflow');
      expect(depthVerdict(red)).toMatch(/served-depth cap/);
    });
  }
});
