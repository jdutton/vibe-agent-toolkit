/**
 * A content-read probe at the `node:fs` boundary, for system tests.
 *
 * A system test injects it into every VAT process it starts with
 * `NODE_OPTIONS=--require <this file>` (see `fs-read-probe.ts`, which builds the
 * environment and reads the dumps back). It counts each read of a file's content
 * under one root, per path, whatever lane asked for it: VAT's work counters
 * count the reads that go through VAT's own read seam, and this catches a lane
 * that reads around it.
 *
 * ## What counts as a content read
 *
 * - `readFile`, `readFileSync` and `fs.promises.readFile` with a path.
 * - `open`, `openSync` and `fs.promises.open` with read-only flags, and
 *   `createReadStream` with a path: VAT reads a document through a handle so it
 *   can size it first.
 *
 * Node's own `readFileSync` opens the file through the public `openSync`, so a
 * sync read nested in a counted sync read is not counted again. Stats, listings
 * and writes are not content reads and are never counted.
 *
 * ## Properties
 *
 * - **Inert unless activated**: nothing is wrapped without {@link DIR_ENV} and
 *   {@link ROOT_ENV}.
 * - **Builtins only**: it runs before anything else in a process it observes.
 * - **Erasable TypeScript only**: Node strips the types when it loads the file,
 *   so there is no build step; `require` is used rather than `import x =
 *   require(...)`, which type stripping cannot erase.
 * - **One dump per thread** at exit, so a worker thread's reads are not lost.
 */

import type * as FsModule from 'node:fs';
import type * as ModuleModule from 'node:module';
import type * as PathModule from 'node:path';
import type * as WorkerThreadsModule from 'node:worker_threads';

const fs = require('node:fs') as typeof FsModule;
const nodePath = require('node:path') as typeof PathModule;
const { threadId } = require('node:worker_threads') as typeof WorkerThreadsModule;

/** The directory each thread writes its dump to. */
const DIR_ENV = 'VAT_TEST_READ_PROBE_DIR';

/** The root under which reads are counted. */
const ROOT_ENV = 'VAT_TEST_READ_PROBE_ROOT';

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Reads per root-relative path, forward slashes. */
const reads = new Map<string, number>();

/** Set while a counted sync read runs, so its own nested `openSync` is not counted. */
let insideSyncRead = false;

/**
 * Each spelling of the root a read's path may start with: as given, and with
 * its symlinks resolved (a temp directory is often reached through one).
 *
 * @param root - The root as the test named it
 * @returns The spellings, each ending in a separator
 */
function rootSpellings(root: string): string[] {
  const spellings = new Set<string>([nodePath.resolve(root)]);
  // The test creates the root before it starts a process, so it resolves; a probe
  // that cannot resolve it should fail the process loudly, not count nothing.
  // eslint-disable-next-line local/no-fs-realpathSync -- a --require preload runs before VAT loads and must use builtins only; it cannot import normalizePath
  spellings.add(fs.realpathSync.native(root));
  return [...spellings].map((spelling) => slashes(spelling).replace(/\/?$/u, '/'));
}

/** A path with forward slashes. */
function slashes(value: string): string {
  // eslint-disable-next-line local/no-manual-path-normalize -- a --require preload uses builtins only; the value is a native path from node:path on the platform that produced it
  return value.replaceAll('\\', '/');
}

/**
 * The root-relative path a read names, if it names one under the root.
 *
 * @param target - The path argument a read was given
 * @param roots - {@link rootSpellings}
 * @returns The relative path, or `undefined` for a descriptor, a handle or a path outside
 */
function relativeUnder(target: unknown, roots: readonly string[]): string | undefined {
  let raw: string | undefined;
  if (typeof target === 'string') raw = target;
  else if (target instanceof URL) raw = target.protocol === 'file:' ? decodeURIComponent(target.pathname) : undefined;
  else if (Buffer.isBuffer(target)) raw = target.toString('utf8');
  if (raw === undefined) return undefined;
  const absolute = slashes(nodePath.resolve(raw));
  const root = roots.find((spelling) => absolute.startsWith(spelling));
  return root === undefined ? undefined : absolute.slice(root.length);
}

/** Whether `open` flags only read. */
function readOnly(flags: unknown): boolean {
  if (flags === undefined || flags === null) return true;
  // Numeric flags carry modifiers (VAT opens with O_RDONLY | O_NONBLOCK): only the access mode decides.
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
  return typeof flags === 'string' && flags.startsWith('r') && !flags.includes('+');
}

/**
 * Replace `holder[name]` with a wrapper that counts a content read first.
 *
 * @param holder - The module object
 * @param name - The method
 * @param roots - {@link rootSpellings}
 * @param isRead - Whether a call with these arguments reads content
 * @param sync - Whether the method is synchronous (its nested sync reads are its own)
 */
function wrap(
  holder: Record<string, unknown>,
  name: string,
  roots: readonly string[],
  isRead: (args: readonly unknown[]) => boolean,
  sync: boolean,
): void {
  const original = holder[name] as AnyFunction | undefined;
  if (typeof original !== 'function') return;
  holder[name] = function counted(this: unknown, ...args: unknown[]): unknown {
    const relative = insideSyncRead ? undefined : relativeUnder(args[0], roots);
    if (relative === undefined || !isRead(args)) return original.apply(this, args);
    reads.set(relative, (reads.get(relative) ?? 0) + 1);
    if (!sync) return original.apply(this, args);
    insideSyncRead = true;
    try {
      return original.apply(this, args);
    } finally {
      insideSyncRead = false;
    }
  };
}

/** Install the wrappers and the exit dump, when activated. */
function install(): void {
  const dir = process.env[DIR_ENV];
  const root = process.env[ROOT_ENV];
  if (dir === undefined || dir === '' || root === undefined || root === '') return;
  const writeFileSync = fs.writeFileSync.bind(fs);
  const roots = rootSpellings(root);
  const always = (): boolean => true;
  const openReads = (args: readonly unknown[]): boolean => readOnly(args[1]);
  const fsHolder = fs as unknown as Record<string, unknown>;
  const promisesHolder = fs.promises as unknown as Record<string, unknown>;
  wrap(fsHolder, 'readFile', roots, always, false);
  wrap(fsHolder, 'readFileSync', roots, always, true);
  wrap(fsHolder, 'createReadStream', roots, always, false);
  wrap(fsHolder, 'open', roots, openReads, false);
  wrap(fsHolder, 'openSync', roots, openReads, true);
  wrap(promisesHolder, 'readFile', roots, always, false);
  wrap(promisesHolder, 'open', roots, openReads, false);
  // An ES module's named import of a builtin binds to its own export record; this
  // carries the wrappers into it even if an ES module loaded `node:fs` first.
  (require('node:module') as typeof ModuleModule).syncBuiltinESMExports();
  process.on('exit', () => {
    const dump = { pid: process.pid, threadId, reads: Object.fromEntries(reads) };
    writeFileSync(nodePath.join(dir, `reads-${String(process.pid)}-${String(threadId)}.json`), JSON.stringify(dump));
  });
}

install();
