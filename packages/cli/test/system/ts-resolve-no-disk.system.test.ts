/**
 * Resolution touches no disk , seen by an instrument that sees stats.
 *
 * The lab's `io` counter (`packages/lab/src/facets/io/counter.cts`) wraps every `fs` method of both
 * APIs and records each call's site. It is injected into a warm run naming `ts_import_targets`
 * over the resolved-import corpus, with `VAT_LAB_IO_WINDOW` set so it buckets only between the step's window
 * open (after its loader returned TypeScript) and close (when the step returns). Loading
 * `typescript.cjs` itself stats the disk once (the `sys` probe), which is not resolution, so the
 * window opens after the load.
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
 * - **window before the load:** a preload opens a window at process start, so the module-load stat
 *   appears, which proves the window is where this test says it is.
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

/** A preload that opens a window at process start, before anything loads TypeScript. */
const EARLY_WINDOW = `'use strict';
const open = globalThis[Symbol.for('vat.lab.io.window')];
if (typeof open === 'function') open();
`;

/**
 * A preload that makes every module resolution ask the disk first through the vendored file's own
 * `sys`. It plants the call in the file's text as it compiles (`Module.prototype._compile`, which
 * every supported Node runs for a CommonJS file, `import()`ed or required): the first statement of
 * `resolveModuleName` becomes `sys.fileExists(containingFile)`. Wrapping the exports instead plants
 * nothing on Node 22, whose `import()` of a CommonJS file keeps the original exports object (its
 * getters are not configurable), so the control would pass for the wrong reason. A preload that
 * finds no declaration to plant in throws, so a renamed function fails the control loudly.
 */
const SYS_FALLBACK = `'use strict';
const Module = require('node:module');
const compile = Module.prototype._compile;
const DECLARATION = 'function resolveModuleName(moduleName, containingFile, compilerOptions, host, cache, redirectedReference, resolutionMode) {';
Module.prototype._compile = function patched(content, filename) {
  if (typeof filename !== 'string' || !filename.endsWith('typescript.cjs')) return compile.apply(this, arguments);
  if (!content.includes(DECLARATION)) throw new Error('sys-fallback: no resolveModuleName declaration to plant in ' + filename);
  return compile.call(this, content.replace(DECLARATION, DECLARATION + ' sys.fileExists(containingFile);'), filename);
};
`;

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

  it('control: a window opened before the load is seen (the module-load stat appears)', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, ['early-window.cjs']);
    expect(run.windows).toBe(2);
    const seen = inVendored(run.buckets).filter((bucket) => /stat/i.test(bucket.method));
    expect(seen.length, JSON.stringify(run.buckets.slice(0, 5))).toBeGreaterThan(0);
  });
});
