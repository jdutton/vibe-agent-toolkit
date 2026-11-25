/**
 * The `perf` facet's probe: the code that runs *inside* each measured vat process.
 *
 * The lab injects this with `NODE_OPTIONS=--require <perf-probe.cjs>`, so it
 * measures main and any later build without their cooperation. Per vat process
 * it writes one JSON record at exit: pid, parent pid, start and end (epoch
 * milliseconds, one clock for every process), `process.resourceUsage()` user and
 * system CPU in microseconds, and when each `Surface:` banner reached stderr.
 *
 * ## What it touches
 *
 * Only vat's own processes, by the rule `harness/vat-process.cts` owns and the
 * `memory` probe shares. In such a process it wraps `process.stderr.write` and
 * forwards every call with the arguments it received, untouched: the chunk, the
 * encoding and the callback go through as given and the return value is the
 * real write's. What it adds is a read of the text and a clock reading. Bytes on
 * stderr are identical with and without it, which
 * `test/integration/perf-probe.integration.test.ts` compares.
 *
 * A banner is seen when one write carries it whole on its own line, as vat's
 * logger writes it. A banner split across two writes would be missed, and so
 * would one written around `process.stderr` (`fs.writeSync(2, ...)`); vat does
 * neither.
 *
 * ## Properties, each load-bearing
 *
 * **Zero non-builtin dependencies**: it is injected into a vat that may be
 * running from an `npx:` build's install, where nothing of the lab's is
 * installed. The one relative require is the shared vat-process rule, which is
 * emitted beside it and is itself builtin-only.
 *
 * **Inert unless activated.** Nothing happens without `VAT_LAB_PERF_LOG`.
 *
 * **Main thread only.** `--require` preloads run in worker threads too, and a
 * worker's record would count one process twice. A worker returns before
 * registering.
 *
 * **Read at exit, FIRST.** The preload's `exit` listener is registered before
 * vat's own, so it runs before them. A process killed by a signal never runs its
 * `exit` listeners and leaves no record; the capture reports a repeat whose
 * process count differs from its siblings' as unmeasured rather than as a small
 * number.
 */

import workerThreads = require('node:worker_threads');

import vatProcess = require('../../harness/vat-process.cjs');

/** Activation variable: the directory to write the record into. */
const LOG_DIR_ENV = 'VAT_LAB_PERF_LOG';

/** How this probe names itself on stderr. */
const PROBE_NAME = 'perf probe';

/** What a banner line starts with, as vat's logger writes it plain on stderr: the triangle, then `Surface: `. */
const BANNER_PREFIX = '\u25B6 Surface: ';

/** One banner as the record carries it. */
interface Banner {
  readonly name: string;
  readonly atMs: number;
}

/**
 * The current time in epoch milliseconds from the process-start-anchored clock, so
 * every process's readings order against every other's.
 *
 * @returns Milliseconds
 */
function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * The banner names in a stderr chunk.
 *
 * @param chunk - What `process.stderr.write` was called with
 * @returns Every banner name in it, in order; none for a chunk that is not text
 */
function bannerNames(chunk: unknown): string[] {
  let text: string;
  if (typeof chunk === 'string') text = chunk;
  else if (chunk instanceof Uint8Array) text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf-8');
  else return [];
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(BANNER_PREFIX)) continue;
    const name = trimmed.slice(BANNER_PREFIX.length).trim();
    if (name !== '') names.push(name);
  }
  return names;
}

/**
 * Record every banner written to stderr, forwarding each write exactly as received.
 *
 * @param banners - Where the banners are collected
 */
function observeStderr(banners: Banner[]): void {
  const original = process.stderr.write;
  process.stderr.write = function observed(this: unknown, ...args: unknown[]): boolean {
    const at = nowMs();
    for (const name of bannerNames(args[0])) banners.push({ name, atMs: at });
    return Reflect.apply(original, this, args) as boolean;
  } as typeof process.stderr.write;
}

/**
 * This process's record, read now.
 *
 * @param startMs - When this process started
 * @param banners - The banners it wrote
 * @returns The record, in the shape `PerfProcessDumpSchema` reads
 */
function recordNow(startMs: number, banners: readonly Banner[]): unknown {
  const usage = process.resourceUsage();
  return {
    pid: process.pid,
    ppid: process.ppid,
    startMs,
    endMs: nowMs(),
    userCpuUs: usage.userCPUTime,
    systemCpuUs: usage.systemCPUTime,
    banners,
  };
}

const configuredLogDir = process.env[LOG_DIR_ENV];
if (
  workerThreads.isMainThread &&
  typeof configuredLogDir === 'string' &&
  configuredLogDir !== '' &&
  vatProcess.isVatMainScript(PROBE_NAME, process.argv[1])
) {
  const startMs = performance.timeOrigin;
  const banners: Banner[] = [];
  observeStderr(banners);
  process.once('exit', () => {
    vatProcess.writeProbeRecord(PROBE_NAME, configuredLogDir, 'perf', () => recordNow(startMs, banners));
  });
}

export = {
  /** Testing surface. The contract with the reader is the JSON file, and only that. */
  __internals: { LOG_DIR_ENV },
};
