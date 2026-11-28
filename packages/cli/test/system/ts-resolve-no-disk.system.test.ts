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
 * The assertion: exactly one window, and no bucket inside it sited in the vendored `typescript.cjs`
 * or the resolve step's modules (`ts-resolve-*`, `ts-stand-ins`, `ts-output-map`, `workspace-links`,
 * `tsconfig-options`, `ts-version-skew`, `io-window`).
 *
 * Positive controls, each red against the same detector, each through a `--require` preload so no
 * source changes:
 * - **host fallback:** a preload wraps `resolveModuleName` of the vendored module so each call first
 *   asks `ts.sys.fileExists`, which is what a host whose `fileExists` fell back to `ts.sys.fileExists`
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

/** Where a call is sited that makes it resolution's own: the vendored file or a step module. */
const RESOLUTION_SITE = /(?:\/vendor\/typescript\.cjs|\/projection\/(?:ts-resolve-[a-z-]+|ts-stand-ins|ts-output-map|ts-version-skew|workspace-links|tsconfig-options|io-window)\.js):\d+/;

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

/** A preload that makes every module resolution ask the disk first through the vendored file's own `sys`. */
const SYS_FALLBACK = `'use strict';
const Module = require('node:module');
const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  const loaded = load.apply(this, arguments);
  if (typeof request !== 'string' || !request.endsWith('typescript.cjs') || typeof loaded.resolveModuleName !== 'function') return loaded;
  // The exports expose resolveModuleName through a getter, so a Proxy answers it instead.
  return new Proxy(loaded, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== 'resolveModuleName') return value;
      return function wrapped(...args) {
        target.sys.fileExists(args[1]);
        return value.apply(this, args);
      };
    },
  });
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

  /** The buckets sited in resolution's own code. */
  const inResolution = (buckets: readonly Bucket[]): Bucket[] => buckets.filter((bucket) => RESOLUTION_SITE.test(bucket.site));

  it('a warm run answers with exactly one window and no bucket sited in the vendored file or the step', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, []);
    expect(run.rows).toBeGreaterThan(0);
    expect(run.windows).toBe(1);
    expect(inResolution(run.buckets)).toEqual([]);
  });

  it('control: a host that falls back to ts.sys.fileExists is seen (a stat sited in the vendored file)', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, ['sys-fallback.cjs']);
    expect(run.windows).toBe(1);
    const seen = inResolution(run.buckets).filter((bucket) => /stat|exists/i.test(bucket.method) && bucket.site.includes('typescript.cjs'));
    expect(seen.length, JSON.stringify(run.buckets.slice(0, 5))).toBeGreaterThan(0);
  });

  it('control: a window opened before the load is seen (the module-load stat appears)', async () => {
    const run = await windowedWarmRun(context, { corpus, preloads }, ['early-window.cjs']);
    expect(run.windows).toBe(2);
    const seen = inResolution(run.buckets).filter((bucket) => /stat/i.test(bucket.method) && bucket.site.includes('typescript.cjs'));
    expect(seen.length, JSON.stringify(run.buckets.slice(0, 5))).toBeGreaterThan(0);
  });
});
