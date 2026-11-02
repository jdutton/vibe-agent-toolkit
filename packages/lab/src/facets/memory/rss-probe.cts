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
 * - **Only vat's own processes.** A process is vat's when its
 *   main script (`process.argv[1]`, its own links read — npm's `.bin/vat` is one)
 *   belongs to one of {@link VAT_PACKAGE_NAMES}: the nearest `package.json`
 *   above it names the launcher or the CLI and is not `private` (the
 *   monorepo's root shares the launcher's name). Decided by the probe from the
 *   install alone, so it holds for every vat ever published — a build needs no
 *   cooperation to be measured — and it excludes what vat is not: `npm` under
 *   `npx`, a `node -e`, a tool vat spawns.
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

/** The packages whose scripts are vat: the umbrella launcher, and the CLI it delegates to. */
const VAT_PACKAGE_NAMES: ReadonlySet<string> = new Set(['vibe-agent-toolkit', '@vibe-agent-toolkit/cli']);

/** Links read from a main script before the probe gives up deciding — a cycle, not an install. */
const MAX_LINK_HOPS = 40;

/** Where Linux states this process image's resident high-water mark. */
const PROC_STATUS = '/proc/self/status';

/**
 * Say on stderr why the probe could not decide, and decide "not vat".
 *
 * A probe that could not tell must not guess vat — that would count an
 * unrelated process — and must not be silent: a repeat that then fails for
 * want of a vat peak needs its cause on record.
 *
 * @param what - What the probe was reading
 * @param error - Why it failed
 */
function undecided(what: string, error: unknown): false {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[vat-lab rss probe] cannot read ${what}: ${reason}\n`);
  return false;
}

/**
 * Whether the nearest `package.json` above `file` names one of vat's packages.
 *
 * @param file - A real (link-resolved) absolute path
 */
function ownedByVat(file: string): boolean {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    // `lstat`, which follows nothing; an absent manifest moves the walk up.
    if (fs.lstatSync(manifest, { throwIfNoEntry: false }) !== undefined) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
        const owner = typeof parsed === 'object' && parsed !== null ? (parsed as { name?: unknown; private?: unknown }) : {};
        // Published packages only: the monorepo's private root is named `vibe-agent-toolkit` too.
        return typeof owner.name === 'string' && VAT_PACKAGE_NAMES.has(owner.name) && owner.private !== true;
      } catch (error) {
        return undecided(manifest, error);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Whether this process's main script is one of vat's.
 *
 * @param main - The main script as the process was started with it
 */
function isVatMainScript(main: string | undefined): boolean {
  if (main === undefined || main === '') return false;
  let file = path.resolve(main);
  try {
    // The installed `.bin/vat` is a link into the package, and its own directory
    // owns nothing — so the script's own link is read, by its text, hop by hop.
    // A link among its ancestors needs no reading: the walk up to the nearest
    // `package.json` passes through it.
    let hops = 0;
    while (fs.lstatSync(file).isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) throw new Error(`more than ${String(MAX_LINK_HOPS)} links`);
      file = path.resolve(path.dirname(file), fs.readlinkSync(file));
    }
  } catch (error) {
    return undecided(main, error);
  }
  return ownedByVat(file);
}

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
 * @param logDir - Directory to write into — the capture's own, made before the process started
 */
function writeDump(logDir: string): void {
  try {
    const dump = JSON.stringify({ pid: process.pid, maxRssKb: peakRssKb() });
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
    if (isVatMainScript(process.argv[1])) writeDump(configuredLogDir);
  });
}

export = {
  /** Testing surface. The contract with the reader is the JSON file, and only that. */
  __internals: { LOG_DIR_ENV, VAT_PACKAGE_NAMES },
};
