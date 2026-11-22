/**
 * The `memory` facet's probe: the code that runs *inside* the measured process.
 *
 * The lab injects this with `NODE_OPTIONS=--require <rss-probe.cjs>`. It patches
 * nothing. On exit it reads the process's peak resident set, in KILOBYTES, and
 * writes one JSON dump:
 *
 * - **Linux: `VmHWM` from `/proc/self/status`** — the high-water mark of THIS
 *   process image's address space. Not `maxRSS`: Linux keeps `ru_maxrss` on the
 *   process across `exec`, and a forked child starts with a copy of its parent's
 *   resident set, so a vat started by a 300 MB parent through `sh -c exec` (how
 *   `npx` and a shell launch it) reported at least 300 MB. `exec` gives the new
 *   image a new address space, and `VmHWM` starts there.
 * - **macOS and Windows: `process.resourceUsage().maxRSS`** (libuv normalizes
 *   macOS's bytes and reads Windows' `PeakWorkingSetSize`). Neither carries a
 *   parent's set into a child: measured on macOS, a vat stand-in under a node
 *   parent holding 0, 300 and 600 MB peaked at 75.4, 75.4 and 75.3 MB. Windows
 *   creates a process rather than forking one; that case is argued, not measured.
 *
 * ## What the number covers
 *
 * - **Worker threads: included.** `maxRSS` is a high-water mark for the whole
 *   process, and workers share it. Measured: a 400 MB buffer allocated in a
 *   worker raises the main thread's `maxRSS` by ~400 MB. So a parse pool's
 *   per-worker heaps are in the number, as they must be.
 * - **Child processes: NOT included in a process's own figure,** and that is
 *   why this is a preload rather than a reading taken by the lab around
 *   `spawnSync`. vat's launcher starts a second node process to do the work; a
 *   reading of the launcher alone would miss everything. Each of vat's own
 *   processes writes its own dump, and the capture reads them all.
 * - **The PARENT's resident set: excluded, on every platform** — by the choice
 *   of figure above, so a repeat launched straight from the lab is measured from
 *   its own start. `test/integration/memory-probe.integration.test.ts` pins it.
 * - **Only vat's own processes**, by the one rule `harness/vat-process.cts`
 *   owns and the `perf` probe shares: decided from the install alone, so a
 *   build needs no cooperation to be measured.
 * - **Read at exit, FIRST.** A high-water mark is monotonic, but the preload's
 *   `exit` listener is registered before vat's own, so it runs before them:
 *   what vat's synchronous exit handlers allocate is not in the figure. A
 *   process killed by a signal, or one V8 aborts out of heap, never runs its
 *   `exit` listeners and leaves no dump — the capture reports that repeat as
 *   unmeasured rather than as a small number.
 *
 * ## Three properties, each load-bearing
 *
 * **Zero non-builtin dependencies**, for the same reason as the `io` counter: it
 * is injected into a vat that may be running from an `npx:` build's install
 * under the arms root, where nothing of the lab's is installed.
 *
 * **Inert unless activated.** Nothing happens without `VAT_LAB_RSS_LOG`.
 *
 * **Main thread only.** `--require` preloads run in worker threads too, and a
 * worker's `exit` would write a second dump carrying the same process-wide
 * figure — one process counted twice. A worker returns before registering.
 */

import fs = require('node:fs');
import workerThreads = require('node:worker_threads');

import vatProcess = require('../../harness/vat-process.cjs');

/** Activation variable: the directory to write the dump into. */
const LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/** How this probe names itself on stderr. */
const PROBE_NAME = 'rss probe';

/** Where Linux states this process image's resident high-water mark. */
const PROC_STATUS = '/proc/self/status';

/**
 * This process image's peak resident set, in kilobytes — see the module header for why Linux
 * reads `VmHWM` and every other platform `maxRSS`.
 *
 * @returns The peak
 * @throws When Linux's status file carries no `VmHWM` line: a figure that silently fell back to
 *   `maxRSS` would carry the parent's set, the error this exists to avoid
 */
function peakRssKb(): number {
  if (process.platform !== 'linux') return process.resourceUsage().maxRSS;
  const line = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(fs.readFileSync(PROC_STATUS, 'utf-8'));
  if (line?.[1] === undefined) throw new Error(`${PROC_STATUS} carries no VmHWM line`);
  return Number(line[1]);
}

const configuredLogDir = process.env[LOG_DIR_ENV];
if (workerThreads.isMainThread && typeof configuredLogDir === 'string' && configuredLogDir !== '') {
  process.once('exit', () => {
    if (!vatProcess.isVatMainScript(PROBE_NAME, process.argv[1])) return;
    vatProcess.writeProbeRecord(PROBE_NAME, configuredLogDir, 'rss', () => ({ pid: process.pid, maxRssKb: peakRssKb() }));
  });
}

export = {
  /** Testing surface. The contract with the reader is the JSON file, and only that. */
  __internals: { LOG_DIR_ENV },
};
