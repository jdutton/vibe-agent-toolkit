/**
 * Spawned plain-`node` probes of VAT's vendored TypeScript, shared by the load test and the pack test.
 *
 * Plain `node` (`process.execPath`), never vitest or `tsx`: both install their own module loaders,
 * which would hide exactly what these tests are about (whether the BUILT file loads the way it
 * ships).
 */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { normalizePath } from '@vibe-agent-toolkit/utils/fs';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { expect, inject } from 'vitest';

import { declaredTypeScriptVersion } from '../helpers/declared-typescript-version.js';

/** What one probe reports. */
export interface ProbeResult {
  readonly version: string;
  /** Statements `createSourceFile` found in the probe's one-statement snippet. */
  readonly statements: number;
  readonly isMainThread: boolean;
  /**
   * The file the loaded module came from (forward-slashed), or null if none was found: the
   * CommonJS cache entry whose `exports` IS the loaded module. Version alone cannot tell the
   * vendored copy from npm `typescript` at the same pin; this can.
   */
  readonly file: string | null;
}

/**
 * The probe, as source: import the built loader by file URL, load TypeScript through it, parse a
 * one-statement snippet. Written with dynamic imports only, so the same text runs as the main
 * script and inside an eval worker.
 *
 * The file: an ESM import of a `.cjs` goes through the CommonJS loader, so this thread's
 * `require.cache` holds an entry whose `exports` is the very object the loader returned.
 */
const PROBE = String.raw`async (entry) => {
  const { pathToFileURL } = await import('node:url');
  const { isMainThread } = await import('node:worker_threads');
  const { createRequire } = await import('node:module');
  const { loadVendoredTypeScript } = await import(pathToFileURL(entry).href);
  const ts = await loadVendoredTypeScript();
  const source = ts.createSourceFile('probe.ts', 'export const answer: number = 42;', ts.ScriptTarget.Latest);
  const loaded = Object.values(createRequire(entry).cache).find((mod) => mod?.exports === ts);
  const file = loaded === undefined ? null : loaded.filename.replaceAll('\\', '/');
  return { version: ts.version, statements: source.statements.length, isMainThread, file };
}`;

/**
 * The worker's code: run {@link PROBE} on `workerData` and post the result back. Dynamic imports
 * only: an eval worker inherits the parent's `--input-type=module`, so it has no `require`.
 */
const WORKER_CODE = `import('node:worker_threads').then(({ parentPort, workerData }) =>
  (${PROBE})(workerData).then((result) => parentPort.postMessage(result)));`;

/** The main script: `argv[1]` is the built loader's path, `argv[2]` says where the probe runs. */
const MAIN_SCRIPT = `const probe = ${PROBE};
const [entry, where] = process.argv.slice(1);
let result;
if (where === 'worker') {
  const { Worker } = await import('node:worker_threads');
  result = await new Promise((resolve, reject) => {
    const worker = new Worker(${JSON.stringify(WORKER_CODE)}, { eval: true, workerData: entry });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
} else {
  result = await probe(entry);
}
process.stdout.write(JSON.stringify(result));`;

/**
 * Run a plain-`node` ESM script and return its stdout, failing with its stderr when it exits non-zero.
 *
 * @param script - The ESM source, run with `--input-type=module -e`
 * @param args - Its `process.argv.slice(1)`
 * @returns What it wrote to stdout
 */
function runNodeScript(script: string, args: readonly string[]): string {
  // `spawnSync` blocks the loop the test's own timeout runs on, so a hung child is bounded here, at
  // that same tier timeout: the probe then fails with the child's stderr instead of hanging the file.
  const result = spawnSync(NODE_EXECUTABLE, ['--input-type=module', '-e', script, ...args], {
    encoding: 'utf-8',
    timeout: inject('tierTestTimeout'),
  });
  expect(result.signal, `the probe was killed (a hang past the tier timeout?)\n${result.stderr}`).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/**
 * Load the vendored TypeScript through the built loader at `entry`, on a fresh process's main
 * thread or in a worker of it, and parse a snippet.
 *
 * @param entry - Absolute path of a built `dist/vendored-typescript.js`
 * @param where - `'main'` for the process's main thread, `'worker'` for a `worker_threads` worker
 * @returns The loaded module's version, the snippet's statement count, and which thread ran it
 */
export function probeVendoredTypeScript(entry: string, where: 'main' | 'worker'): ProbeResult {
  return JSON.parse(runNodeScript(MAIN_SCRIPT, [entry, where])) as ProbeResult;
}

/**
 * What a probe of a correctly built loader reports: the declared version, the snippet parsed, the
 * thread it was asked for, and the vendored copy beside the loader (`<dist>/vendor/typescript.cjs`)
 * as the file, by its real path, as the CommonJS loader keys it.
 *
 * @param entry - Absolute path of a built `dist/vendored-typescript.js`
 * @param where - Where the probe runs
 * @returns The expected probe result
 */
export function declaredProbeResult(entry: string, where: 'main' | 'worker'): ProbeResult {
  return {
    version: declaredTypeScriptVersion(),
    statements: 1,
    isMainThread: where === 'main',
    file: toForwardSlash(safePath.join(normalizePath(dirname(entry), { within: dirname(entry) }), 'vendor/typescript.cjs')),
  };
}

/**
 * Assert a probe loaded the vendored copy beside the loader, at the declared version, and parsed the
 * snippet, on the thread it was asked for.
 *
 * @param entry - Absolute path of a built `dist/vendored-typescript.js`
 * @param where - Where the probe runs
 */
export function expectProbeLoadsDeclaredVersion(entry: string, where: 'main' | 'worker'): void {
  expect(probeVendoredTypeScript(entry, where)).toEqual(declaredProbeResult(entry, where));
}

/** What a module namespace held, as a fresh `node` imported it. */
export interface ModuleShape {
  /** The namespace's own keys. */
  readonly keys: readonly string[];
  /** `version` on the namespace's `default` (a CommonJS module's `module.exports`), if any. */
  readonly defaultVersion: unknown;
  /** Whether `default.createSourceFile` is a function. */
  readonly parses: boolean;
}

/**
 * Import `file` in a fresh plain-`node` process and report what its namespace held.
 *
 * @param file - Absolute path of the module to import
 * @returns Its namespace's shape
 */
export function importedShape(file: string): ModuleShape {
  const script = `const { pathToFileURL } = await import('node:url');
const ns = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify({
  keys: Object.keys(ns),
  defaultVersion: ns.default?.version ?? null,
  parses: typeof ns.default?.createSourceFile === 'function',
}));`;
  return JSON.parse(runNodeScript(script, [file])) as ModuleShape;
}
