/**
 * The `io` facet's counter: the code that runs *inside* the measured process.
 *
 * The lab injects this with `NODE_OPTIONS=--require <counter.cjs>`, so it loads
 * before anything else and can replace the filesystem and child-process entry
 * points with wrappers that count. On exit it writes one JSON dump per process.
 *
 * ## Why this file is `.cts`
 *
 * `--require` only accepts CommonJS and `@vibe-agent-toolkit/lab` is an ESM
 * package, so this is authored as `.cts` and emitted as `dist/.../counter.cjs`.
 * It uses `import x = require('node:fs')` rather than `import * as x from
 * 'node:fs'` deliberately: with `esModuleInterop`, the latter emits
 * `__importStar(require('node:fs'))`, which hands back a *copy* of the module
 * namespace whose properties are getters onto the original. Patching that copy
 * patches nothing — silently — and every count comes back zero.
 *
 * ## Four properties, each load-bearing
 *
 * **Zero non-builtin dependencies.** It is injected into a vat that may be
 * running from a temp dir via `npx`, where nothing of the lab's is installed.
 * A single `require` of anything outside `node:` crashes the process it was
 * supposed to observe. `test/io-counter.test.ts` scans the *emitted* file.
 *
 * **Inert unless activated.** Nothing happens without `VAT_LAB_IO_LOG`. A stray
 * `NODE_OPTIONS` left in a shell must not perturb unrelated processes.
 *
 * **Both halves of the API, deduped by function identity.** Two measured facts,
 * both cheap to rediscover expensively:
 *
 * - Patching only `fs.*Sync` attributed **40** calls on `vat resources scan
 *   docs/` where also patching the promise API attributed **436**. vat reads
 *   documents through `fs/promises`; a sync-only counter reports a precise,
 *   confident lie.
 * - `require('fs/promises') === require('fs').promises` is `true`. Wrapping
 *   "both" wraps the same function twice, so one real call records two entries
 *   and every promise-API number doubles. Hence {@link WRAPPED_TAG}: a wrapper
 *   tags itself, and anything already tagged is skipped.
 *
 * **Attribution, with the loader reported rather than dropped.** On a real run,
 * **6,371 of 6,411** fs calls came from Node's own module loader. A raw total is
 * not a measurement of vat. Each call is attributed to the first stack frame
 * that is neither `node:` internal nor this file; calls with no such frame are
 * class `loader` and aggregate per method under an empty site. They stay in the
 * dump, because a reader has to be able to tell "we bucketed 6,371 out" from
 * "there were only 40".
 *
 * ## Rows are per entry point, and must not be summed across methods
 *
 * Measured: Node's own `fs.readFileSync` calls the **public** `fs.openSync`,
 * `fs.readSync` and `fs.closeSync`, all of which are wrapped here. One logical
 * read therefore appears on four rows sharing one site. That is deliberate —
 * the descriptor level is where the syscalls are, and vat does fd-level work
 * directly too — but it means a reader asking "how many file reads?" sums
 * *within* a method, never across all of them.
 *
 * The re-entrancy guard does not suppress this and must not: it is scoped to
 * the bookkeeping, not to the duration of the wrapped call. A duration-scoped
 * guard would be incoherent for the promise API, which returns immediately, and
 * would make the sync and promise numbers mean different things.
 *
 * ## What it costs
 *
 * Measured on `vat resources validate docs/` (7 runs each): 910 ms median
 * uninstrumented, 994 ms instrumented — **+9.2 %**. The dump for that run:
 * 8,625 recorded calls, of which **6,277 were the loader** and 2,348 were vat's
 * own, across 2,044 rows.
 *
 * ## What is deliberately not here
 *
 * No signal handlers. Registering `SIGINT`/`SIGTERM` to flush would change how
 * the measured process terminates, which is a worse distortion than losing the
 * dump of a killed run. A run that is killed produces no dump, and that is
 * legible.
 */

import type * as ChildProcessModule from 'node:child_process';
import type * as FsModule from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import path = require('node:path');

/** Body-schema version of the dump file. The dump reader refuses others. */
const DUMP_VERSION = 1;

/**
 * Largest distinct-argument set kept per bucket.
 *
 * Beyond this the bucket sets `argsCapped` and `distinctArgs` becomes a FLOOR
 * rather than an exact count. Unbounded would mean holding every path a big
 * crawl ever touched, in the measured process's heap.
 */
const ARG_CAP = 4096;

/**
 * How many stack frames to capture per call.
 *
 * Deeper than V8's default 10 on purpose, and the gap is not marginal. Measured
 * on `vat resources validate docs/` in this repo:
 *
 * | limit | user calls | loader calls | rows | best of 3 |
 * |------:|-----------:|-------------:|-----:|----------:|
 * |    10 |        333 |        8,292 |   29 |    886 ms |
 * |    16 |      2,348 |        6,277 | 2044 |    919 ms |
 * |    24 |      2,348 |        6,277 | 2044 |    999 ms |
 *
 * At V8's default, the window runs out among `node:` internals before reaching
 * the real caller, so **2,015 of vat's own calls are misfiled as loader** — a
 * sevenfold under-count of the thing being measured, reported with total
 * confidence. Attribution saturates by 16; 24 is headroom for a deeper call
 * chain in another command, bought for a few percent of wall time.
 *
 * Set and restored around each capture, so a measured process that sets
 * `Error.stackTraceLimit = 0` for speed (a real optimisation, and one vat's
 * dependencies could adopt tomorrow) cannot silently turn every row into
 * `loader`.
 */
const STACK_FRAMES = 24;

/** Env var naming the directory dumps are written to. Absent ⇒ fully inert. */
const LOG_DIR_ENV = 'VAT_LAB_IO_LOG';

/**
 * Marks a function this counter has already wrapped.
 *
 * `Symbol.for` rather than `Symbol()` so that two *copies* of this file (two
 * `--require` entries, or a stale build alongside a fresh one) still recognise
 * each other's wrappers and refuse to double-wrap.
 */
const WRAPPED_TAG: unique symbol = Symbol.for('vat.lab.io.counter.wrapped');

/** Any callable we might wrap. */
type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** A callable carrying the counter's tag once wrapped. */
type TaggedFunction = AnyFunction & { [WRAPPED_TAG]?: true };

/** Which side of the attribution split a call fell on. */
type CallClass = 'loader' | 'user';

/** One `(cls, method, site)` bucket, accumulating while the process runs. */
interface Bucket {
  readonly cls: CallClass;
  readonly method: string;
  readonly site: string;
  count: number;
  /**
   * Distinct string first-arguments seen here, or `null` when args are not
   * tracked (loader rows). Only the SIZE is ever reported — the values are
   * absolute machine-specific paths and would make two reports incomparable.
   */
  readonly args: Set<string> | null;
  argsCapped: boolean;
}

/** One row of the dump, exactly as the dump reader consumes it. */
interface DumpRow {
  readonly cls: CallClass;
  readonly method: string;
  readonly site: string;
  readonly count: number;
  /**
   * How many distinct string first-arguments this bucket saw.
   *
   * The N+1 detector, and the reason this facet exists: 66 reads of 66 files is
   * necessary work; 66 reads of the *same* file is a bug. `0` on a `user` row
   * with a non-zero count means no call had a string first argument (fd-based
   * work); on a `loader` row it means args are not tracked at all. A `true`
   * `argsCapped` makes this number a floor.
   */
  readonly distinctArgs: number;
  readonly argsCapped: boolean;
}

/** Everything one activated counter needs while the process runs. */
interface CounterState {
  readonly logDir: string;
  /** This file, so its own frames never win attribution. */
  readonly selfFile: string;
  readonly buckets: Map<string, Bucket>;
  /** Re-entrancy guard: stack capture must not recurse into the counter. */
  inside: boolean;
}

/**
 * The real fs entry points, captured at load time *before* any patching.
 *
 * Two reasons this is not "just call `fs.writeFileSync` at exit": the counter
 * would count its own dump, and a measured process that patched fs after us
 * would have its patch counted as our write.
 */
interface CapturedFs {
  readonly writeFileSync: (file: string, data: string) => void;
  readonly mkdirSync: (dir: string, options: { recursive: true }) => unknown;
  readonly existsSync: (file: string) => boolean;
}

/**
 * Operations present on BOTH the callback `fs` API and `fs/promises`.
 *
 * Names absent from a given Node version are skipped by the `typeof` guard in
 * {@link wrapFunction}, so this list may name newer additions safely.
 */
const FS_SHARED_OPS = [
  'access',
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'glob',
  'lchmod',
  'lchown',
  'link',
  'lstat',
  'mkdir',
  'mkdtemp',
  'open',
  'opendir',
  'readdir',
  'readFile',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'statfs',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
] as const;

/** Descriptor-level operations, which exist on the callback and sync APIs only. */
const FS_DESCRIPTOR_OPS = [
  'close',
  'fchmod',
  'fchown',
  'fdatasync',
  'fstat',
  'fsync',
  'ftruncate',
  'futimes',
  'lutimes',
  'read',
  'readv',
  'write',
  'writev',
] as const;

/** Synchronous `fs` methods to wrap. */
const FS_SYNC_METHODS: readonly string[] = [
  ...FS_SHARED_OPS.map((op) => `${op}Sync`),
  ...FS_DESCRIPTOR_OPS.map((op) => `${op}Sync`),
  'existsSync',
];

/** Callback-style `fs` methods to wrap. Streams open files, so they count too. */
const FS_CALLBACK_METHODS: readonly string[] = [
  ...FS_SHARED_OPS,
  ...FS_DESCRIPTOR_OPS,
  'exists',
  'watch',
  'watchFile',
  'unwatchFile',
  'createReadStream',
  'createWriteStream',
];

/**
 * `fs/promises` methods to wrap — the half a sync-only counter misses, and the
 * half vat actually uses for document reading.
 */
const FS_PROMISE_METHODS: readonly string[] = [...FS_SHARED_OPS, 'watch'];

/** `child_process` entry points. Their first argument is the command. */
const CHILD_PROCESS_METHODS: readonly string[] = [
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
];

/**
 * Fresh, empty counter state.
 *
 * @param logDir - Directory the dump will be written to
 * @param selfFile - Absolute path of this file, whose frames are skipped
 * @returns The state
 */
function createState(logDir: string, selfFile: string): CounterState {
  return { logDir, selfFile, buckets: new Map<string, Bucket>(), inside: false };
}

/**
 * The `file:line` of a single stack frame, or `null` when it has no location.
 *
 * Handles the four shapes V8 emits — `at name (loc)`, `at loc`, `at async name
 * (loc)`, and locationless frames like `at native` — and normalises `file://`
 * URLs to filesystem paths so an ESM-loaded module and a CJS-loaded one produce
 * the same site string. The column is dropped: it moves with formatting while
 * naming the same call.
 *
 * @param frame - One line of `Error.prototype.stack`
 * @returns `file:line`, or `null` if the frame names no location
 */
function parseFrameLocation(frame: string): string | null {
  const trimmed = frame.trim();
  if (!trimmed.startsWith('at ')) {
    return null;
  }
  const rest = trimmed.slice(3).trim();

  let location: string;
  if (rest.endsWith(')') && rest.includes('(')) {
    location = rest.slice(rest.lastIndexOf('(') + 1, -1);
  } else {
    location = rest.startsWith('async ') ? rest.slice(6).trim() : rest;
  }

  if (location.startsWith('file://')) {
    location = fileUrlToPath(location);
  }

  // `^(.*):(\d+):(\d+)$` — the greedy head keeps a Windows drive colon and a
  // `node:` scheme intact while taking only the trailing line:column pair.
  const withPosition = /^(.*):(\d+):(\d+)$/.exec(location);
  if (withPosition === null) {
    return null;
  }
  return `${withPosition[1] ?? ''}:${withPosition[2] ?? ''}`;
}

/**
 * A `file://` URL as a filesystem path.
 *
 * Hand-rolled rather than `node:url`, because this runs on every stack frame of
 * every call and the counter keeps its require surface as small as it can.
 * Handles the two forms Node emits in stacks: `file:///abs/path` and
 * `file:///C:/abs/path`.
 *
 * @param url - A `file://` URL, possibly with a trailing `:line:col`
 * @returns The equivalent path
 */
function fileUrlToPath(url: string): string {
  let decoded = url.slice('file://'.length);
  // A host component (`file://host/share`) is left alone — a UNC path is a real
  // filesystem location and rewriting it would name a different file.
  if (decoded.startsWith('/') && /^\/[a-zA-Z]:/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  try {
    return decodeURIComponent(decoded);
  } catch {
    return decoded;
  }
}

/**
 * Which class a call belongs to, and where in the measured program it came from.
 *
 * The first frame that is neither a `node:` internal nor this file is the site,
 * and the class is `user`. When no such frame exists the call came from Node's
 * own loader; the class is `loader` and the site is empty, so loader rows
 * aggregate per method rather than fragmenting across internal line numbers.
 *
 * @param stack - A captured `Error.prototype.stack`
 * @param selfFile - Absolute path of this file
 * @returns The class and site
 */
function classifyStack(stack: string, selfFile: string): { cls: CallClass; site: string } {
  for (const frame of stack.split('\n')) {
    const location = parseFrameLocation(frame);
    // eslint-disable-next-line local/no-path-startswith -- 'node:' is a module SCHEME, not a path prefix; no separator is involved
    if (location === null || location.startsWith('node:')) {
      continue;
    }
    // eslint-disable-next-line local/no-path-startswith -- both sides originate from V8 (the stack frame and `__filename`), so their separators are identical by construction; the suffix being matched is a ':line' marker, not a path segment
    if (location === selfFile || location.startsWith(`${selfFile}:`)) {
      continue;
    }
    return { cls: 'user', site: location };
  }
  return { cls: 'loader', site: '' };
}

/**
 * Record one call.
 *
 * Returns without recording while already inside the counter: capturing a stack
 * can itself touch the filesystem (source maps), and a wrapper that recursed
 * would both corrupt the count and blow the stack. The original function still
 * runs — only the bookkeeping is skipped.
 *
 * @param state - Counter state
 * @param method - Stable method label, e.g. `fs.promises.readFile`
 * @param args - The call's arguments; only a string first argument is inspected
 */
function record(state: CounterState, method: string, args: readonly unknown[]): void {
  if (state.inside) {
    return;
  }
  state.inside = true;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_FRAMES;
    const { cls, site } = classifyStack(new Error().stack ?? '', state.selfFile);
    const key = `${cls}\u0000${method}\u0000${site}`;

    let bucket = state.buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        cls,
        method,
        site,
        count: 0,
        args: cls === 'user' ? new Set<string>() : null,
        argsCapped: false,
      };
      state.buckets.set(key, bucket);
    }
    bucket.count += 1;

    const first = args[0];
    if (bucket.args !== null && typeof first === 'string' && !bucket.args.has(first)) {
      if (bucket.args.size >= ARG_CAP) {
        bucket.argsCapped = true;
      } else {
        bucket.args.add(first);
      }
    }
  } finally {
    Error.stackTraceLimit = previousLimit;
    state.inside = false;
  }
}

/**
 * Replace `owner[key]` with a counting wrapper, once.
 *
 * The identity check is the whole defence against double counting:
 * `require('fs/promises')` and `require('fs').promises` are the same object, so
 * the counter reaches the same function twice and must skip the second visit.
 *
 * Own symbols are copied onto the wrapper so `util.promisify.custom` (which
 * `fs.exists`, `fs.read` and friends carry) still works, and a `native`
 * sub-function is preserved *and* wrapped under its own label —
 * `fs.realpathSync` and `fs.realpathSync.native` differ in path-casing
 * behaviour on macOS and Windows, so one bucket would hide a real difference.
 *
 * @param state - Counter state the wrapper records into
 * @param owner - Object holding the function
 * @param key - Property name on `owner`
 * @param label - Stable method label for the report
 */
function wrapFunction(state: CounterState, owner: object, key: string, label: string): void {
  const original = Reflect.get(owner, key) as unknown;
  if (typeof original !== 'function') {
    return;
  }
  const target = original as TaggedFunction;
  if (target[WRAPPED_TAG] === true) {
    return;
  }

  const wrapper: TaggedFunction = function (this: unknown, ...args: unknown[]): unknown {
    record(state, label, args);
    return target.apply(this, args);
  };
  wrapper[WRAPPED_TAG] = true;

  // Keep the wrapper indistinguishable from what it replaced, so a measured
  // program that introspects `name`/`length` or promisifies it still works.
  Object.defineProperty(wrapper, 'name', { value: target.name, configurable: true });
  Object.defineProperty(wrapper, 'length', { value: target.length, configurable: true });
  for (const symbol of Object.getOwnPropertySymbols(target)) {
    if (symbol !== WRAPPED_TAG) {
      Reflect.set(wrapper, symbol, Reflect.get(target, symbol));
    }
  }

  const native = Reflect.get(target, 'native') as unknown;
  if (typeof native === 'function') {
    Reflect.set(wrapper, 'native', native);
    wrapFunction(state, wrapper, 'native', `${label}.native`);
  }

  Reflect.set(owner, key, wrapper);
}

/**
 * Wrap every named method on one object under a shared label prefix.
 *
 * @param state - Counter state
 * @param owner - The module object to patch, patched in place
 * @param methods - Method names to wrap when present
 * @param prefix - Label prefix, e.g. `fs.promises.`
 */
function wrapAll(
  state: CounterState,
  owner: object,
  methods: readonly string[],
  prefix: string,
): void {
  for (const method of methods) {
    wrapFunction(state, owner, method, `${prefix}${method}`);
  }
}

/**
 * The accumulated buckets as sorted dump rows.
 *
 * Sorted so two dumps of the same work diff cleanly rather than reporting a
 * difference that belongs to Map insertion order.
 *
 * @param state - Counter state
 * @returns Rows, ordered by class, then method, then site
 */
function toRows(state: CounterState): DumpRow[] {
  const rows: DumpRow[] = [];
  for (const bucket of state.buckets.values()) {
    rows.push({
      cls: bucket.cls,
      method: bucket.method,
      site: bucket.site,
      count: bucket.count,
      distinctArgs: bucket.args === null ? 0 : bucket.args.size,
      argsCapped: bucket.argsCapped,
    });
  }
  rows.sort((a, b) => {
    if (a.cls !== b.cls) {
      return a.cls < b.cls ? -1 : 1;
    }
    if (a.method !== b.method) {
      return a.method < b.method ? -1 : 1;
    }
    if (a.site === b.site) {
      return 0;
    }
    return a.site < b.site ? -1 : 1;
  });
  return rows;
}

/** How many `io-<pid>-<n>.json` names to try before giving up on a free one. */
const DUMP_INDEX_LIMIT = 10_000;

/**
 * The first unused `io-<pid>-<n>.json` in a directory.
 *
 * pids are recycled, and repeats of one command share a log directory, so a
 * name keyed on pid alone would let a later run silently overwrite an earlier
 * measurement.
 *
 * @param dir - Log directory
 * @param pid - The dumping process
 * @param exists - Predicate for "this file is already there"
 * @returns A path to write
 */
function nextDumpPath(dir: string, pid: number, exists: (file: string) => boolean): string {
  for (let index = 0; index < DUMP_INDEX_LIMIT; index++) {
    const candidate = path.join(dir, `io-${pid}-${index}.json`);
    if (!exists(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, `io-${pid}-${DUMP_INDEX_LIMIT}.json`);
}

/**
 * Write the dump, using the fs functions captured before any patching.
 *
 * A failure here is reported on stderr rather than swallowed: a missing dump
 * that nobody mentioned looks exactly like a process that did no I/O, and that
 * is the most expensive wrong answer this file can give. It never throws — a
 * measurement must not break the thing it measures.
 *
 * @param state - Counter state
 * @param captured - The pre-patch fs entry points
 */
function writeDump(state: CounterState, captured: CapturedFs): void {
  try {
    captured.mkdirSync(state.logDir, { recursive: true });
    const file = nextDumpPath(state.logDir, process.pid, captured.existsSync);
    captured.writeFileSync(
      file,
      JSON.stringify({ dumpVersion: DUMP_VERSION, pid: process.pid, rows: toRows(state) }),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[vat-lab io counter] failed to write dump: ${reason}\n`);
  }
}

/**
 * Patch this process and arrange for a dump on exit.
 *
 * Order matters twice over: the real fs entry points are captured *before* the
 * patching below, and `fs/promises` is walked before `fs.promises` so the
 * shared functions settle on one label. The second walk is not redundant — it
 * is what proves the dedupe is doing its job on the real module graph.
 *
 * @param logDir - Directory to write the dump into
 */
function activate(logDir: string): void {
  const fs = require('node:fs') as typeof FsModule;
  const fsPromises = require('node:fs/promises') as typeof FsPromisesModule;
  // eslint-disable-next-line security/detect-child-process -- the counter WRAPS child_process to count spawns; it never spawns anything itself
  const childProcess = require('node:child_process') as typeof ChildProcessModule;

  const captured: CapturedFs = {
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    existsSync: fs.existsSync,
  };

  const state = createState(logDir, __filename);

  wrapAll(state, fsPromises, FS_PROMISE_METHODS, 'fs.promises.');
  // Same object as `fsPromises` on every Node released so far; the identity tag
  // makes this a no-op rather than a doubling. Walked anyway so that a future
  // Node which splits them is measured rather than half-measured.
  wrapAll(state, fs.promises, FS_PROMISE_METHODS, 'fs.promises.');
  wrapAll(state, fs, FS_SYNC_METHODS, 'fs.');
  wrapAll(state, fs, FS_CALLBACK_METHODS, 'fs.');
  wrapAll(state, childProcess, CHILD_PROCESS_METHODS, 'child_process.');

  process.once('exit', () => {
    writeDump(state, captured);
  });
}

const configuredLogDir = process.env[LOG_DIR_ENV];
if (typeof configuredLogDir === 'string' && configuredLogDir !== '') {
  try {
    activate(configuredLogDir);
  } catch (error) {
    // Never take the measured process down. A run with no dump is a legible
    // failure; a run that crashed because of the instrument is not.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[vat-lab io counter] failed to activate: ${reason}\n`);
  }
}

export = {
  /**
   * Testing surface. Not part of any contract with the dump reader — that
   * contract is the JSON file, and only the JSON file.
   */
  __internals: {
    ARG_CAP,
    CHILD_PROCESS_METHODS,
    DUMP_VERSION,
    FS_CALLBACK_METHODS,
    FS_PROMISE_METHODS,
    FS_SYNC_METHODS,
    LOG_DIR_ENV,
    WRAPPED_TAG,
    classifyStack,
    createState,
    nextDumpPath,
    parseFrameLocation,
    toRows,
    wrapFunction,
  },
};
