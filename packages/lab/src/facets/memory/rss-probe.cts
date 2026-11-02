/**
 * The `memory` facet's probe: the code that runs *inside* the measured process.
 *
 * The lab injects this with `NODE_OPTIONS=--require <rss-probe.cjs>`. It patches
 * nothing. On exit it reads `process.resourceUsage().maxRSS` — the process's
 * peak resident set, in KILOBYTES on every platform (libuv normalizes macOS's
 * bytes and reads Windows' `PeakWorkingSetSize`) — and writes one JSON dump.
 * That is the whole of its portability argument: no `/usr/bin/time -l`, which is
 * macOS-only, and no `/proc` reading, which is Linux-only.
 *
 * ## What the number covers
 *
 * - **Worker threads: included.** `maxRSS` is a high-water mark for the whole
 *   process, and workers share it. Measured: a 400 MB buffer allocated in a
 *   worker raises the main thread's `maxRSS` by ~400 MB. So a parse pool's
 *   per-worker heaps are in the number, as they must be.
 * - **Child processes: NOT included,** and that is why this is a preload rather
 *   than a reading taken by the lab around `spawnSync`. vat's launcher starts a
 *   second node process to do the work; a reading of the launcher alone would
 *   miss everything. Every node process that inherits `NODE_OPTIONS` writes its
 *   own dump, and the capture reads them all.
 * - **Read at exit.** A high-water mark is monotonic, so exit is the peak. A
 *   process killed by a signal, or one V8 aborts out of heap, never runs its
 *   `exit` listeners and leaves no dump — the capture reports that repeat as
 *   unmeasured rather than as a small number.
 *
 * ## Three properties, each load-bearing
 *
 * **Zero non-builtin dependencies**, for the same reason as the `io` counter: it
 * is injected into a vat that may be running from an `npx` temp dir, where
 * nothing of the lab's is installed.
 *
 * **Inert unless activated.** Nothing happens without `VAT_LAB_RSS_LOG`.
 *
 * **Main thread only.** `--require` preloads run in worker threads too, and a
 * worker's `exit` would write a second dump carrying the same process-wide
 * figure — one process counted twice. A worker returns before registering.
 */

import crypto = require('node:crypto');
import fs = require('node:fs');
import path = require('node:path');
import workerThreads = require('node:worker_threads');

/** Activation variable: the directory to write the dump into. */
const LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/**
 * Write this process's peak, under a name no other process in the directory holds.
 *
 * A random suffix rather than the pid alone: pids are recycled across the
 * processes one repeat spawns, and a pid-keyed name would let a later process
 * overwrite a sibling's dump. `wx` makes the impossible collision a loud failure
 * instead of a silent overwrite.
 *
 * Never throws — a measurement must not break the thing it measures — but a
 * failure is said on stderr: a missing dump nobody mentioned would read as a
 * process that never ran.
 *
 * @param logDir - Directory to write into
 */
function writeDump(logDir: string): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const dump = JSON.stringify({ pid: process.pid, maxRssKb: process.resourceUsage().maxRSS });
    const file = path.join(logDir, `rss-${String(process.pid)}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, dump, { flag: 'wx' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[vat-lab rss probe] failed to write dump: ${reason}\n`);
  }
}

const configuredLogDir = process.env[LOG_DIR_ENV];
if (workerThreads.isMainThread && typeof configuredLogDir === 'string' && configuredLogDir !== '') {
  process.once('exit', () => {
    writeDump(configuredLogDir);
  });
}

export = {
  /** Testing surface. The contract with the reader is the JSON file, and only that. */
  __internals: { LOG_DIR_ENV },
};
