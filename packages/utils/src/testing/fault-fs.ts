/**
 * `installFaultFs` — an in-process fs fault injector for tests.
 *
 * A destructive verb is only as safe as its behaviour on the filesystem's bad
 * days: a full disk, a read-only mount, a file the OS refuses deep in a tree. The
 * real thing cannot be summoned on demand, so this module fails a chosen call
 * with a chosen errno, and can rewrite what `stat` reports (an `ino` of 0, a
 * case-aliased identity).
 *
 * ## How it reaches code that never asked to be faulted
 *
 * 1. It replaces the methods ON THE BUILTIN OBJECTS — `require('node:fs')`,
 *    `fs.promises` (the same object as `node:fs/promises`) and
 *    `FileHandle.prototype` — for all three API styles (`*Sync`, callback,
 *    promise).
 * 2. It then calls `module.syncBuiltinESMExports()`, so a named import
 *    (`import { rmSync } from 'node:fs'`) sees the replacement. `restore()` undoes
 *    both steps.
 * 3. Dependencies that look methods up on the module object at call time — node-tar
 *    (`import fs from 'fs'`), adm-zip (`require('fs')`) and write streams
 *    (`createWriteStream` resolves `open`/`write` from the module) — see the
 *    replacements with no extra seam. `test/integration/fault-fs-reach` and the CLI's
 *    `fault-fs-archive-reach` pin every one of these; none is assumed.
 * 4. An fd to path map, filled from intercepted `open*`, gives handle and stream
 *    operations the path they act on.
 * 5. `realpathSync.native` and `realpath.native` are properties of the functions, not
 *    of the module, so they are wrapped on the wrappers, traced as the op `realpath`.
 *
 * ## What it cannot reach
 *
 * ⚠️ `cpSync`, and on Node >= 23 recursive `rmSync`, are implemented natively: the
 * harness can fail the CALL (family `write` / `remove`) but never a file inside it.
 * A verb that wants per-file fault coverage must not use those calls.
 *
 * ⚠️ Recursive `fs.rm` / `fs.promises.rm` keep the `fs` functions they found the first time Node
 * removed a tree in this process. If that was outside a session — on Node 22 any earlier
 * recursive `rmSync`, which is what a test's cleanup does; on later Nodes an earlier `fs.rm` — no
 * session sees or fails a call INSIDE the removal, only the `rm` call itself.
 *
 * ⚠️ A `FileHandle` is only traced when it was opened AFTER `installFaultFs`:
 * the fd to path map cannot know the path of a handle that was already open, and
 * the prototype is patched when the first traced handle is opened. Install first,
 * then open.
 *
 * ## Counting
 *
 * Calls made synchronously from inside an intercepted call (an `fs` function that
 * is itself written in terms of another public one) are not traced again, so one
 * caller-visible operation is one {@link FsCall}. A rule fires on its `nth` match
 * only; the calls around it succeed. `FsApi` `'stream'` is reserved: stream I/O
 * reaches the harness as `callback` calls on the fs object, which is what it is —
 * so one stream write is three calls (`open`, `write`, `close`), each counted.
 *
 * ⛔ Framework-free, like everything under `testing/`: no `vitest` import, so the
 * `./testing` subpath keeps the empty third-party set its purity pin asserts.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { relativeEscapesRoot, safePath } from '../path-core.js';

import { type FaultRule, type FsApi, type FsOpFamily, injectedErrnoError, type InjectedErrno, OPS, type OpSpec } from './fault-spec.js';

export interface FsCall {
  readonly seq: number;
  readonly op: string;
  readonly family: FsOpFamily;
  readonly api: FsApi;
  /** Forward-slash, absolute; for handle ops, the path the fd was opened at. */
  readonly path: string;
  /** The rename / copyFile / symlink target side. */
  readonly dest?: string;
}

export interface StatRewrite {
  readonly op: 'stat' | 'lstat' | 'fstat';
  readonly path: (path: string) => boolean;
  readonly rewrite: <S extends { ino: number | bigint; dev: number | bigint }>(stats: S) => S;
}

export interface FaultFsSession {
  /** Only calls under `within`. */
  readonly calls: readonly FsCall[];
  /** The calls that were failed. */
  readonly fired: readonly FsCall[];
  /** Idempotent; also undoes `syncBuiltinESMExports`. */
  restore(): void;
  /**
   * Resolves once no traced asynchronous call is in flight. A caller's promise can settle while
   * work it started goes on — Node's `rm` rejects on the first child that fails and leaves its
   * siblings running — so a run is over when this resolves, not when its verb returns: restore
   * earlier and that work runs on under the NEXT session.
   *
   * @throws Error when calls are still in flight after 10 s (a run that never settles is hung)
   */
  settled(): Promise<void>;
}

/** How long {@link FaultFsSession.settled} waits for in-flight calls before it calls the run hung. */
const SETTLE_LIMIT_MS = 10_000;

type Fn = (...args: unknown[]) => unknown;
/** `FileHandle.prototype` method name to the op it is traced as. */
const HANDLE_OPS: Readonly<Record<string, string>> = {
  read: 'read', readFile: 'readFile', write: 'write', writev: 'writev', writeFile: 'writeFile',
  appendFile: 'appendFile', stat: 'fstat', chmod: 'fchmod', truncate: 'ftruncate', sync: 'fsync',
};

const REWRITABLE_OPS: ReadonlySet<string> = new Set(['stat', 'lstat', 'fstat']);

interface Patch { readonly target: object; readonly key: string; readonly original: unknown }

interface Session extends FaultFsSession {
  readonly within: string;
  readonly faults: readonly FaultRule[];
  readonly rewrites: readonly StatRewrite[];
  readonly hits: Map<FaultRule, number>;
  /** The call an `everyTry` rule failed last, while no other traced call has followed it. */
  readonly retried: { last?: { readonly rule: FaultRule; readonly call: FsCall } };
  readonly fdPaths: Map<number, string>;
  readonly patches: Patch[];
  readonly mutableCalls: FsCall[];
  readonly mutableFired: FsCall[];
  handlePatched: boolean;
  restored: boolean;
  /** Traced asynchronous calls whose original has not completed yet. */
  inFlight: number;
}

let active: Session | undefined;
/** Non-zero while an intercepted call is running its original body synchronously, or while {@link untracedFs} runs. */
let depth = 0;

/**
 * Run `work` — synchronous fs calls a TEST makes on its own behalf while a session is active (a mock
 * standing in for a child process, capturing what it was handed) — outside the session: none of its
 * calls is traced, so none becomes an injection point, and none is failed. Without it a harness's own
 * bookkeeping is indistinguishable from the code under test.
 *
 * ⛔ Synchronous only: an asynchronous call started inside returns to the event loop with the session
 * active again, and its continuation is traced.
 */
export function untracedFs<T>(work: () => T): T {
  depth += 1;
  try {
    return work();
  } finally {
    depth -= 1;
  }
}

const isUnder = (root: string, path: string): boolean => !relativeEscapesRoot(safePath.relative(root, path));

function toPath(value: unknown): string | undefined {
  if (typeof value === 'string') return safePath.resolve(value);
  if (value instanceof URL) return safePath.resolve(fileURLToPath(value));
  if (Buffer.isBuffer(value)) return safePath.resolve(value.toString());
  return undefined;
}

function openFamily(flags: unknown): FsOpFamily {
  if (flags === undefined) return 'read';
  if (typeof flags === 'number') {
    const writing = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
    return (flags & writing) === 0 ? 'read' : 'write';
  }
  return typeof flags === 'string' && /^[rs]+$/.test(flags) ? 'read' : 'write';
}

/** The fd a call acts on: the handle's own for a handle method, else the first argument. */
function fdOf(style: FsApi, self: unknown, args: readonly unknown[]): number | undefined {
  const value = style === 'handle' ? (self as { fd?: unknown } | undefined)?.fd : args[0];
  return typeof value === 'number' ? value : undefined;
}

function locate(spec: OpSpec, style: FsApi, self: unknown, args: readonly unknown[], session: Session): { path: string; dest?: string } | undefined {
  // A handle method acts on its own fd whatever its module twin takes (`readFile` takes a path there).
  if (spec.shape === 'fd' || style === 'handle') {
    const fd = fdOf(style, self, args);
    const path = fd === undefined ? undefined : session.fdPaths.get(fd);
    return path === undefined ? undefined : { path };
  }
  const first = toPath(args[0]);
  if (spec.shape === 'one') return first === undefined ? undefined : { path: first };
  const second = toPath(args[1]);
  if (first === undefined || second === undefined) return undefined;
  return spec.shape === 'link' ? { path: second, dest: first } : { path: first, dest: second };
}

/** Record the call if it is under `within`; undefined means it is not ours to touch. */
function trace(session: Session, op: string, spec: OpSpec, style: FsApi, self: unknown, args: readonly unknown[]): FsCall | undefined {
  const located = locate(spec, style, self, args, session);
  if (located === undefined) return undefined;
  const { path, dest } = located;
  if (!isUnder(session.within, path) && !(dest !== undefined && isUnder(session.within, dest))) return undefined;
  const flags = typeof args[1] === 'function' ? undefined : args[1];
  const family = spec.family === 'open' ? openFamily(flags) : spec.family;
  const call: FsCall = {
    seq: session.mutableCalls.length + 1, op, family, api: style, path, ...(dest === undefined ? {} : { dest }),
  };
  session.mutableCalls.push(call);
  return call;
}

/** Whether `call` is `earlier` asked again: the same operation, through the same API, on the same paths. */
function isRepeatOf(earlier: FsCall, call: FsCall): boolean {
  return earlier.op === call.op && earlier.api === call.api && earlier.path === call.path && earlier.dest === call.dest;
}

function faultFor(session: Session, call: FsCall): InjectedErrno | undefined {
  // A retry of the call an `everyTry` rule just failed fails again, and is no new match of any rule.
  const { last } = session.retried;
  if (last !== undefined && isRepeatOf(last.call, call)) return last.rule.errno;
  delete session.retried.last;
  for (const rule of session.faults) {
    const matches = (rule.family === undefined || rule.family === call.family)
      && (rule.op === undefined || rule.op === call.op)
      && (rule.path(call.path) || (call.dest !== undefined && rule.path(call.dest)));
    if (!matches) continue;
    const seen = (session.hits.get(rule) ?? 0) + 1;
    session.hits.set(rule, seen);
    if (seen !== (rule.nth ?? 1)) continue;
    if (rule.everyTry === true) session.retried.last = { rule, call };
    return rule.errno;
  }
  return undefined;
}

function fail(style: FsApi, args: readonly unknown[], error: Error): unknown {
  if (style === 'promise' || style === 'handle') return Promise.reject(error);
  const callback = [...args].reverse().find((arg): arg is Fn => typeof arg === 'function');
  if (style === 'callback' && callback !== undefined) {
    process.nextTick(callback, error);
    return undefined;
  }
  throw error;
}

/**
 * An injected `close` fault, as the OS reports one: close(2) releases the descriptor even when
 * it returns an error, so the real close runs and only then is the fault reported. A close the
 * injection skipped would leave the descriptor open for the rest of the process, and Node closes
 * an abandoned `FileHandle` during garbage collection as an uncaught error. A real close that
 * itself fails is reported as itself: the injection only ever adds a fault, never hides one.
 */
function failAfterClosing(style: FsApi, close: Fn, args: readonly unknown[], error: Error): unknown {
  depth += 1;
  try {
    if (style === 'promise' || style === 'handle') {
      return (close(...args) as Promise<unknown>).then(() => Promise.reject(error));
    }
    const index = args.findLastIndex((arg) => typeof arg === 'function');
    if (style === 'callback' && index >= 0) {
      const callback = args[index] as Fn;
      // A real close that itself fails is reported as itself, as the other styles do.
      close(...args.slice(0, index), (closeError: unknown) => callback(closeError ?? error));
      return undefined;
    }
    // A real close that itself fails is a real fault, and propagates as one.
    close(...args);
    throw error;
  } finally {
    depth -= 1;
  }
}

function patch(session: Session, target: object, key: string, make: (original: Fn) => Fn): void {
  const original = (target as Record<string, unknown>)[key];
  if (typeof original !== 'function') return;
  const wrapped = make(original as Fn);
  // Carry `realpath.native`, util.promisify.custom and the like over to the wrapper.
  for (const own of Reflect.ownKeys(original)) {
    if (own === 'length' || own === 'name' || own === 'prototype') continue;
    Object.defineProperty(wrapped, own, Object.getOwnPropertyDescriptor(original, own) as PropertyDescriptor);
  }
  session.patches.push({ target, key, original });
  (target as Record<string, unknown>)[key] = wrapped;
}

function rewriteStats(session: Session, op: string, path: string, value: { ino: number | bigint; dev: number | bigint }): unknown {
  let stats = value;
  for (const rule of session.rewrites) {
    if (rule.op === op && rule.path(path)) stats = rule.rewrite(stats);
  }
  return stats;
}

/** What to do with a successful result: map an opened fd, patch the first handle, rewrite stats. */
function adaptResult(session: Session, op: string, call: FsCall, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    if (op === 'open' && typeof value === 'number') session.fdPaths.set(value, call.path);
    return value;
  }
  if (op === 'open') {
    const fd = (value as { fd?: unknown }).fd;
    if (typeof fd === 'number') session.fdPaths.set(fd, call.path);
    patchFileHandle(session, value);
    return value;
  }
  return REWRITABLE_OPS.has(op) ? rewriteStats(session, op, call.path, value as { ino: number | bigint; dev: number | bigint }) : value;
}

/**
 * Route a callback API's success value through `settle`, and count the call in flight until its
 * callback runs; other arguments pass untouched.
 */
function settleInCallback(session: Session, args: readonly unknown[], settle: (value: unknown) => unknown): unknown[] {
  const index = args.findLastIndex((arg) => typeof arg === 'function');
  const callback = args[index] as Fn | undefined;
  if (callback === undefined) return [...args];
  const out = [...args];
  session.inFlight += 1;
  out[index] = (error: unknown, value?: unknown, ...rest: unknown[]) => {
    session.inFlight -= 1;
    return callback(error, error ? value : settle(value), ...rest);
  };
  return out;
}

/** Count a promise-API call in flight until it settles, whichever way. */
function countedPromise(session: Session, result: Promise<unknown>, settle: (value: unknown) => unknown): Promise<unknown> {
  session.inFlight += 1;
  return result.finally(() => {
    session.inFlight -= 1;
  }).then(settle);
}

/**
 * The wrapper acts for whichever session is active WHEN IT IS CALLED, not the one that made it: code
 * that captured an `fs` function while a session was active (Node's own `fs.promises.rm` does, on its
 * first call) keeps calling this wrapper after `restore()`, and must be traced by every later session.
 */
function makeWrapper(op: string, spec: OpSpec, style: FsApi, original: Fn): Fn {
  return function wrapped(this: unknown, ...args: unknown[]): unknown {
    const session = active;
    if (session === undefined || depth > 0) return original.apply(this, args);
    const call = trace(session, op, spec, style, this, args);
    if (call === undefined) return original.apply(this, args);
    const errno = faultFor(session, call);
    if (errno !== undefined) {
      session.mutableFired.push(call);
      const error = injectedErrnoError(errno, op, call.path);
      return op === 'close' ? failAfterClosing(style, original.bind(this), args, error) : fail(style, args, error);
    }
    // A close forgets its fd whatever the API; the fd is only known before the call.
    const closing = op === 'close' ? fdOf(style, this, args) : undefined;
    const settle = (value: unknown): unknown => {
      if (closing !== undefined) session.fdPaths.delete(closing);
      return adaptResult(session, op, call, value);
    };
    const callArgs = style === 'callback' ? settleInCallback(session, args, settle) : args;
    depth += 1;
    let result: unknown;
    try {
      result = original.apply(this, callArgs);
    } finally {
      depth -= 1;
    }
    if (style === 'sync') return settle(result);
    if (style === 'promise' || style === 'handle') return countedPromise(session, result as Promise<unknown>, settle);
    return result;
  };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => {
  setImmediate(resolve);
});

/** Turn the event loop until nothing the session traced is in flight: a completed call's continuation may start the next one. */
async function settledOf(session: Session, deadline = Date.now() + SETTLE_LIMIT_MS): Promise<void> {
  await nextTurn();
  if (session.inFlight === 0) return;
  if (Date.now() > deadline) throw new Error(`fault-fs: ${session.inFlight} traced fs call(s) still in flight after ${SETTLE_LIMIT_MS} ms`);
  return settledOf(session, deadline);
}

/**
 * Patch `FileHandle.prototype` from the first traced handle, and every traced handle's own
 * `close` (Node defines it per handle, as a class field); `restore()` puts all of them back.
 */
function patchFileHandle(session: Session, handle: object): void {
  const close = OPS['close'];
  if (close !== undefined) patch(session, handle, 'close', (original) => makeWrapper('close', close, 'handle', original));
  if (session.handlePatched) return;
  session.handlePatched = true;
  const prototype = Object.getPrototypeOf(handle) as object;
  for (const [method, op] of Object.entries(HANDLE_OPS)) {
    const spec = OPS[op];
    if (spec !== undefined) patch(session, prototype, method, (original) => makeWrapper(op, spec, 'handle', original));
  }
}

/**
 * Wrap `realpathSync.native` and `realpath.native` as the op `realpath`. They hang off the
 * functions as properties, so {@link patch} copies them onto the wrappers UNWRAPPED, and
 * `normalizePath` asks the native one first: without this every product realpath fault was
 * out of the harness's reach. The patch lands on the wrapper, which `restore()` drops along
 * with its property; the originals never change.
 */
function patchNativeRealpath(session: Session): void {
  const spec = OPS['realpath'];
  if (spec === undefined) return;
  patch(session, fs.realpathSync, 'native', (original) => makeWrapper('realpath', spec, 'sync', original));
  patch(session, fs.realpath, 'native', (original) => makeWrapper('realpath', spec, 'callback', original));
}

/**
 * Trace and fault fs calls on paths under `within` until `restore()` is called.
 *
 * One session at a time: a second install while one is active throws, because two
 * stacked sets of wrappers cannot be unwound independently.
 */
export function installFaultFs(options: {
  within: string;
  faults?: readonly FaultRule[];
  rewrites?: readonly StatRewrite[];
}): FaultFsSession {
  if (active !== undefined) throw new Error('installFaultFs: a fault session is already active; restore() it first');
  const mutableCalls: FsCall[] = [];
  const mutableFired: FsCall[] = [];
  const session: Session = {
    within: safePath.resolve(options.within),
    faults: options.faults ?? [],
    rewrites: options.rewrites ?? [],
    hits: new Map(),
    retried: {},
    fdPaths: new Map(),
    patches: [],
    mutableCalls,
    mutableFired,
    handlePatched: false,
    restored: false,
    inFlight: 0,
    calls: mutableCalls,
    fired: mutableFired,
    restore() {
      if (session.restored) return;
      session.restored = true;
      for (const { target, key, original } of session.patches.toReversed()) {
        (target as Record<string, unknown>)[key] = original;
      }
      session.fdPaths.clear();
      if (active === session) active = undefined;
      syncBuiltinESMExports();
    },
    settled: () => settledOf(session),
  };
  active = session;
  for (const [op, spec] of Object.entries(OPS)) {
    patch(session, fs, `${op}Sync`, (original) => makeWrapper(op, spec, 'sync', original));
    patch(session, fs, op, (original) => makeWrapper(op, spec, 'callback', original));
    patch(session, fs.promises, op, (original) => makeWrapper(op, spec, 'promise', original));
  }
  patchNativeRealpath(session);
  syncBuiltinESMExports();
  return session;
}
