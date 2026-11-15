/**
 * A parse thread's full collection: what a reused thread runs before its next job when it holds
 * too much (`settleReusedHeap` in `parse-limits.ts`).
 *
 * ## How it is had
 *
 * V8 installs a `gc` global only in a context created while its `--expose-gc` flag is set. The
 * flag is set, one new context is created to take its `gc`, and the flag is cleared again — once,
 * as the thread's module loads, before any job runs. The function collects the heap of the isolate
 * it belongs to, which is the thread's.
 *
 * ## Why the flag is cleared, and why under a lock
 *
 * The flag is process-wide. Left set, every context created after it — a host's `vm` sandbox for
 * untrusted code on the main thread included — would have a `gc` that forces a full collection of
 * the main heap, a lever for whoever runs in that sandbox; and V8 folds its flags into
 * `v8.cachedDataVersionTag()`, so a code cache written while it is set is rejected by a process
 * without it. So it is held only while one context is created.
 *
 * Clearing it races: a thread that clears it while another is between setting it and creating its
 * context leaves that one with no collector (Node 24.21: 6% of 4 threads started at once, 9–13.5%
 * of 8). Set, acquire and clear therefore run under a lock — one `Int32` in a `SharedArrayBuffer`
 * the pool's module creates once and hands every thread it starts (`ParseWorkerData.collectorLock`)
 * — so within one copy of this library they never overlap.
 *
 * **Residual:** two copies of this library in one process (two installed versions) hold two locks,
 * and can still race; so can a host that sets or clears the flag itself. The cost is a thread with
 * no collector, which is retired past its reused-thread bound instead of collected (`settledForJob`
 * in `parse-worker.ts`) — a thread start, never a verdict. A context another thread creates in the
 * moment the flag is held gets a `gc` too. And a holder terminated between setting the flag and
 * clearing it leaves `--expose-gc` set, process-wide, until the next thread acquires (and clears
 * it), which may be never.
 *
 * Node's documentation warns that changing V8 flags after the VM has started "may result in
 * unpredictable behavior". This flag configures no heap size, collector or compiler, and changes
 * nothing a program computes. Measured on Node 22.16, 24.21 and 26.7, with and without a process
 * `--max-old-space-size=512`, run five times each: the function collected 55, 185 and 405 MiB of
 * garbage to 6.7 MiB in 2–17 ms. A process already run with `--expose-gc` has one on the thread's
 * global, which is used, and the flag is never touched.
 */

import v8 from 'node:v8';
import vm from 'node:vm';
import { threadId } from 'node:worker_threads';

/** How long one wait on the lock lasts before the holder is looked at again, in ms. */
const LOCK_WAIT_SLICE_MS = 20;

/**
 * This thread's full collection, or `null` when this runtime would not give one — see the module
 * documentation.
 *
 * A holder that keeps the lock past `staleMs` is taken to have died holding it (a thread terminated
 * while it loaded), and the lock is taken from it: waiting on it forever would hang every thread
 * started after. A holder that was only slow then races this one, which costs at most a collector.
 *
 * @param lock - The pool's lock: one `Int32`, 0 when free, else the holder's `threadId`
 * @param staleMs - How long one holder may keep the lock before it is taken from it
 * @returns The thread's collection, or `null`
 */
export function acquireCollector(lock: Int32Array, staleMs: number): (() => void) | null {
  const exposed: unknown = (globalThis as { gc?: unknown }).gc;
  if (typeof exposed === 'function') return () => (exposed as () => void)();
  // `threadId` is 0 on the main thread, and 0 is the free value: the main thread holds as -1.
  const me = threadId === 0 ? -1 : threadId;
  takeLock(lock, me, staleMs);
  try {
    return collectorUnderFlag();
  } finally {
    Atomics.compareExchange(lock, 0, me, 0);
    Atomics.notify(lock, 0);
  }
}

/**
 * Take the lock, waiting while another thread holds it, and taking it from a holder that keeps it
 * past `staleMs`.
 *
 * @param lock - See {@link acquireCollector}
 * @param me - This thread's holder value
 * @param staleMs - See {@link acquireCollector}
 */
function takeLock(lock: Int32Array, me: number, staleMs: number): void {
  let holder = Atomics.compareExchange(lock, 0, 0, me);
  let watched = holder;
  let watchedSince = performance.now();
  while (holder !== 0) {
    if (holder !== watched) {
      watched = holder;
      watchedSince = performance.now();
    }
    if (performance.now() - watchedSince >= staleMs && Atomics.compareExchange(lock, 0, holder, me) === holder) return;
    Atomics.wait(lock, 0, holder, LOCK_WAIT_SLICE_MS);
    holder = Atomics.compareExchange(lock, 0, 0, me);
  }
}

/**
 * Set the flag, take a new context's `gc`, and clear the flag — the caller holds the lock.
 *
 * @returns The collection, or `null` when the runtime refused the flag or the context
 */
function collectorUnderFlag(): (() => void) | null {
  let gc: unknown;
  try {
    v8.setFlagsFromString('--expose-gc');
    try {
      // `typeof`, so a context created without the flag answers `undefined` rather than throwing.
      gc = vm.runInNewContext("typeof gc === 'function' ? gc : undefined");
    } finally {
      v8.setFlagsFromString('--no-expose-gc');
    }
    // eslint-disable-next-line local/no-blind-catch -- whatever refused the flag or the context, the answer is the same one: no collector, so a reused thread past its bound is retired (a thread start, never a verdict), and no surface reads why
  } catch {
    return null;
  }
  return typeof gc === 'function' ? () => (gc as () => void)() : null;
}
