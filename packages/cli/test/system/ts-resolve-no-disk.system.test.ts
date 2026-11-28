/**
 * Resolution touches no disk , seen by an instrument that sees stats.
 *
 * The lab's `io` counter (`packages/lab/src/facets/io/counter.cts`) wraps every `fs` method of both
 * APIs and records each call's site. It is injected into a warm run naming `ts_import_targets`
 * over the resolved-import corpus, with `VAT_LAB_IO_WINDOW` set so it buckets only between the step's window
 * open (after its loader returned TypeScript) and close (when the step returns). Loading
 * `typescript.cjs` may itself stat the disk (its `sys` probes case sensitivity with a `fileExists`,
 * except on Windows, where `isFileSystemCaseSensitive` returns before touching the disk), which is
 * not resolution, so the window opens after the load.
 *
 * The assertion: exactly one window, and no bucket inside it at all, whatever its site: no module
 * list to keep (the step's modules are derived from its import graph by the static proof,
 * `packages/dev-tools/test/parser-import-boundary.test.ts`), so a module the step starts to call
 * that reads the disk is seen without being named. Sites are matched as forward-slash paths
 * (`toForwardSlash`): a CommonJS frame is a raw file path, a backslash one on Windows.
 *
 * Positive controls, each red against the same detector, each through a `--require` preload so no
 * source changes:
 * - **host fallback:** a preload plants a `sys.fileExists` call as the first statement of the vendored
 *   module's `resolveModuleName`, so each call first asks the disk, which is what a host whose `fileExists` fell back to `ts.sys.fileExists`
 *   does: a `statSync` sited in `typescript.cjs`, inside the window;
 * - **window before the load:** a preload makes the load stat the disk on every platform (a
 *   `statSync` planted as the first statement of `isFileSystemCaseSensitive`, which the load calls),
 *   and another opens a window at process start, so that stat appears. The same plant without the
 *   early window leaves the step's window empty, which proves the window opens after the load on
 *   every platform, Windows included, where the unplanted load stats nothing.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, freshDataArm, type DataArm } from '../helpers/data-rows.js';
import { TS_RESOLVE_FILES } from '../helpers/ts-resolve-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext } from './test-common.js';

const SQL = 'SELECT * FROM ts_import_targets';

/** The built counter; `--require` takes CommonJS, and this is what ships. */
const COUNTER = toForwardSlash(fileURLToPath(new URL('../../../lab/dist/facets/io/counter.cjs', import.meta.url)));

/** A call sited in the vendored TypeScript, on any host's path spelling once forward-slashed. */
const VENDORED_SITE = /\/vendor\/typescript\.cjs:\d+/;

/** One bucket of a dump. */
interface Bucket {
  readonly cls: string;
  readonly method: string;
  readonly site: string;
  readonly count: number;
}

/**
 * A preload that opens a window at process start on the main thread, before anything loads
 * TypeScript there. Only the main thread: `--require` preloads run in every worker too, and a
 * worker's dump is written or not as it happens to exit, so a window opened there would make the
 * window count vary run to run.
 */
const EARLY_WINDOW = `'use strict';
const open = globalThis[Symbol.for('vat.lab.io.window')];
if (typeof open === 'function' && require('node:worker_threads').isMainThread) open();
`;

/**
 * A preload that plants a statement in the vendored file's text as it compiles
 * (`Module.prototype._compile`, which every supported Node runs for a CommonJS file, `import()`ed or
 * required): `plant` becomes the first statement of the function `declaration` opens. Wrapping the
 * exports instead plants nothing on Node 22, whose `import()` of a CommonJS file keeps the original
 * exports object (its getters are not configurable), so a control would pass for the wrong reason.
 * A preload that finds no declaration to plant in throws, so a renamed function fails loudly.
 *
 * @param label - Names the preload in its error
 * @param declaration - The function's opening line, exactly as the vendored file spells it
 * @param plant - The statement to plant
 * @returns The preload's source
 */
function plantingPreload(label: string, declaration: string, plant: string): string {
  return `'use strict';
const Module = require('node:module');
const compile = Module.prototype._compile;
const DECLARATION = ${JSON.stringify(declaration)};
Module.prototype._compile = function patched(content, filename) {
  if (typeof filename !== 'string' || !filename.endsWith('typescript.cjs')) return compile.apply(this, arguments);
  if (!content.includes(DECLARATION)) throw new Error(${JSON.stringify(label + ': no declaration to plant in ')} + filename);
  return compile.call(this, content.replace(DECLARATION, DECLARATION + ${JSON.stringify(' ' + plant)}), filename);
};
`;
}

/**
 * Every module resolution asks the disk first through the vendored file's own `sys`: the first
 * statement of `resolveModuleName` becomes `sys.fileExists(containingFile)`.
 */
const SYS_FALLBACK = plantingPreload(
  'sys-fallback',
  'function resolveModuleName(moduleName, containingFile, compilerOptions, host, cache, redirectedReference, resolutionMode) {',
  'sys.fileExists(containingFile);',
);

/**
 * Loading the vendored file stats the disk on every platform: `isFileSystemCaseSensitive`, which
 * `sys` calls as the file loads, first stats the file itself, so a stat sited in `typescript.cjs`
 * happens before the step's window opens. Unplanted, Windows' load stats nothing.
 */
const LOAD_STAT = plantingPreload('load-stat', 'function isFileSystemCaseSensitive() {', 'require("node:fs").statSync(__filename);');

/** What a run needs of its suite. */
interface Suite {
  readonly binPath: string;
  readonly createTempDir: () => string;
}

/** A warm run (the same cache, a second time) with the counter, windowed, and the extra preloads. */
async function windowedWarmRun(
  context: Suite,
  where: { readonly corpus: string; readonly preloads: string },
  extra: readonly string[],
): Promise<{ buckets: Bucket[]; windows: number; rows: number }> {
  const arm: DataArm = freshDataArm(context, false);
  await countedQuery(context, where.corpus, arm, SQL);
  const log = context.createTempDir();
  const requires = [COUNTER, ...extra.map((name) => toForwardSlash(safePath.join(where.preloads, name)))];
  const env = {
    NODE_OPTIONS: requires.map((file) => `--require "${file}"`).join(' '),
    VAT_LAB_IO_LOG: log,
    VAT_LAB_IO_WINDOW: '1',
  };
  const run = await countedQuery(context, where.corpus, arm, SQL, env);
  const rows = answeredRows(run).length;
  const dumps = readdirSync(log)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(safePath.join(log, name), 'utf8')) as { rows: Bucket[]; windows?: number });
  return {
    buckets: dumps.flatMap((dump) => dump.rows),
    windows: dumps.reduce((sum, dump) => sum + (dump.windows ?? 0), 0),
    rows,
  };
}

describe('resolution touches no disk (system test)', () => {
  const context = createSuiteContext('vat-ts-resolve-no-disk-', import.meta.url);
  let corpus = '';
  let preloads = '';
  beforeAll(() => {
    context.setup();
    corpus = safePath.join(context.createTempDir(), 'corpus');
    writeCorpus(corpus, TS_RESOLVE_FILES);
    commitTestFixture(corpus);
    preloads = context.createTempDir();
    writeFileSync(safePath.join(preloads, 'early-window.cjs'), EARLY_WINDOW);
    writeFileSync(safePath.join(preloads, 'sys-fallback.cjs'), SYS_FALLBACK);
    writeFileSync(safePath.join(preloads, 'load-stat.cjs'), LOAD_STAT);
  });
  afterAll(() => context.cleanup());

  /** The buckets sited in the vendored TypeScript. */
  const inVendored = (buckets: readonly Bucket[]): Bucket[] => buckets.filter((bucket) => VENDORED_SITE.test(toForwardSlash(bucket.site)));

  it('a warm run answers with exactly one window and no bucket inside it, of any site', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, []);
    expect(run.rows).toBeGreaterThan(0);
    expect(run.windows).toBe(1);
    expect(run.buckets).toEqual([]);
  });

  it('control: a host that falls back to ts.sys.fileExists is seen (a stat sited in the vendored file)', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, ['sys-fallback.cjs']);
    expect(run.windows).toBe(1);
    const seen = inVendored(run.buckets).filter((bucket) => /stat|exists/i.test(bucket.method));
    expect(seen.length, JSON.stringify(run.buckets.slice(0, 5))).toBeGreaterThan(0);
  });

  it('control: a window opened before the load is seen (the planted load stat appears)', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, ['load-stat.cjs', 'early-window.cjs']);
    expect(run.windows).toBe(2);
    const seen = inVendored(run.buckets).filter((bucket) => /stat/i.test(bucket.method));
    expect(seen.length, JSON.stringify(run.buckets.filter((bucket) => bucket.cls === 'user'))).toBeGreaterThan(0);
  });

  it('the step\'s window opens after the load: the planted load stat is outside it', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, ['load-stat.cjs']);
    expect(run.rows).toBeGreaterThan(0);
    expect(run.windows).toBe(1);
    expect(run.buckets).toEqual([]);
  });
});
