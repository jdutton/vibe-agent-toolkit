/**
 * Deterministic work counters: how much work a vat process did, counted at the
 * code sites that do it.
 *
 * Wall time says a command is slow and moves with the machine; a count of rows
 * decoded, extents derived or git processes started does not. The fact-extractor
 * ADR (`docs/architecture/fact-extractors.md`, I10) gates the warm path on these
 * counts rather than on milliseconds, and this module is the one contract they
 * are counted through. Nothing here gates anything: it counts, and the lab's
 * `work` facet reads the counts.
 *
 * ## One contract
 *
 * - The name set is closed ({@link WORK_COUNTER_NAMES}); a count against any
 *   other name throws, and the lab's strict schema derives its names from the
 *   same tuple.
 * - Counting is always on. {@link WORK_COUNTERS_ENV} decides only whether the
 *   process writes a dump at exit, through the same `writeTimingDump` every
 *   per-process seam uses.
 * - `n` is required and must be a count: a negative or non-integer `n` throws,
 *   so a site cannot quietly subtract or record a fraction.
 *
 * ## Threads
 *
 * The code never asks `isMainThread`: unit tests run in threads and an adopter
 * may embed VAT in a worker of its own, so the main thread is not where counting
 * belongs. Instead a thread whose work is counted elsewhere says so —
 * `parse-worker.ts` calls {@link forbidWorkCounting} at startup, because its
 * parent counts every job it dispatches and settles. A count after that is a
 * site counting on the wrong side of the boundary: it is reported once on
 * stderr and dropped, never thrown into an adopter's run. No environment
 * variable changes that; a test that wants the throw turns it on through
 * `throwOnForbiddenWorkCountForTest` on `./testing`.
 */

import { ensureTimingDirectory, normalizeTimingDirectory, writeTimingDump } from './timing-dump.js';

/**
 * Every work counter, in dump order. Closed: a new counter is a new entry here,
 * and the lab's schema follows from this tuple.
 *
 * The `.persistent` / `.ephemeral` split is the projection store's lane: the
 * file-backed store a warm run reads, against the per-run in-memory store a
 * query writes its answer database into, which I10 does not bound.
 */
export const WORK_COUNTER_NAMES = [
  'store.rows.decoded.persistent',
  'store.rows.decoded.ephemeral',
  'store.reads.persistent',
  'store.reads.ephemeral',
  'store.writes.persistent',
  'store.writes.ephemeral',
  'store.rows.written.persistent',
  'store.rows.written.ephemeral',
  'extent.derived',
  'extent.served',
  'store.miss.refusedPairs',
  'parse.cache.hit',
  'parse.dispatched',
  'parse.refused.keyDetermined',
  'parse.refused.inputCap.read',
  'parse.refused.inputCap.dispatch',
  'parse.refused.load',
  'content.hashed',
  'content.hashedBytes',
  'git.calls',
] as const;

/** One work counter's name. */
export type WorkCounter = (typeof WORK_COUNTER_NAMES)[number];

/**
 * Which process wrote a dump. `wrapper` is the context-detecting `vat` binary
 * that spawns the CLI; `cli` is the CLI itself, where the work happens.
 */
export const WORK_COUNTER_ROLES = ['wrapper', 'cli'] as const;

/** One {@link WORK_COUNTER_ROLES} entry. */
export type WorkCounterRole = (typeof WORK_COUNTER_ROLES)[number];

/** One process's dump: no version field — the reader's strict schema decides what it reads. */
export interface WorkCounterDump {
  readonly pid: number;
  readonly role: WorkCounterRole;
  readonly counters: Readonly<Record<WorkCounter, number>>;
}

/** The variable naming the directory a process writes its dump to. Counting does not depend on it. */
export const WORK_COUNTERS_ENV = 'VAT_WORK_COUNTERS';

/** What the seam is called in a failure line. */
const DUMP_NOUN = 'work-counter';

/** Basename stem of a dump; the pid and any collision counter follow it. */
const DUMP_BASENAME = 'work-counters';

/** Each counter's slot in {@link counts}. */
const SLOT = new Map<string, number>(WORK_COUNTER_NAMES.map((name, slot) => [name, slot]));

/** The counts, one slot per {@link WORK_COUNTER_NAMES} entry. Per thread, as every module state is. */
const counts = new Float64Array(WORK_COUNTER_NAMES.length);

/** Set by {@link forbidWorkCounting}: this thread's work is counted by another. */
let forbidden = false;

/** Whether this thread has already reported a forbidden count. Once per thread. */
let reportedForbidden = false;

/** Set only by {@link throwOnForbiddenWorkCountForTest}: a forbidden count throws instead. */
let throwOnForbidden = false;

/** Whether {@link installWorkCounterDump} has been called with the dump on. */
let dumpInstalled = false;

/** Called after {@link __resetWorkCountersForTest}: modules holding a baseline against the counters. */
const resetListeners: Array<() => void> = [];

/**
 * Count `n` units of work against one counter.
 *
 * @param counter - Which counter
 * @param n - How many: a non-negative integer, never defaulted
 * @throws RangeError for a name outside {@link WORK_COUNTER_NAMES} or an `n`
 *   that is not a count; Error for a count on a thread that forbids counting,
 *   only once a test has called `throwOnForbiddenWorkCountForTest`
 */
export function countWork(counter: WorkCounter, n: number): void {
  const slot = SLOT.get(counter);
  if (slot === undefined) throw new RangeError(`'${String(counter)}' is not a work counter`);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`work counter '${counter}' was given ${String(n)}, which is not a non-negative integer`);
  }
  if (forbidden) {
    const finding = `work counter '${counter}' counted on a thread that forbids work counting (its parent counts this work)`;
    if (throwOnForbidden) throw new Error(finding);
    if (!reportedForbidden) {
      reportedForbidden = true;
      process.stderr.write(`vat: ${finding}; not counted\n`);
    }
    return;
  }
  counts[slot] = (counts[slot] ?? 0) + n;
}

/**
 * This thread's counts, every counter present, zeros included.
 *
 * @returns A snapshot; later counts do not change it
 */
export function readWorkCounters(): Readonly<Record<WorkCounter, number>> {
  return Object.fromEntries(WORK_COUNTER_NAMES.map((name, slot) => [name, counts[slot] ?? 0])) as Record<
    WorkCounter,
    number
  >;
}

/**
 * Declare that this thread's work is counted by another thread — see the
 * module header. Called once at a worker's startup.
 */
export function forbidWorkCounting(): void {
  forbidden = true;
}

/**
 * Run `listener` whenever the counters are zeroed under test, so a module that
 * reads them against a baseline of its own (`resources`' parse timing) re-takes
 * it rather than reporting a negative count. Production never zeroes them.
 *
 * @param listener - Re-takes the caller's baseline
 */
export function onWorkCountersReset(listener: () => void): void {
  resetListeners.push(listener);
}

/**
 * Build this process's dump body.
 *
 * @param role - Which process is writing it
 * @returns The body
 */
function buildDump(role: WorkCounterRole): WorkCounterDump {
  return { pid: process.pid, role, counters: readWorkCounters() };
}

/**
 * Write this process's counts at exit, when {@link WORK_COUNTERS_ENV} names a
 * directory. Called only from a process entry point — the `vat` wrapper and the
 * CLI — never from a worker, so one process files one dump.
 *
 * @param role - Which entry point this is
 * @throws Error when called a second time in a process with the dump on: two
 *   exit writes would file the same counts twice
 */
export function installWorkCounterDump(role: WorkCounterRole): void {
  const directory = normalizeTimingDirectory(process.env[WORK_COUNTERS_ENV]);
  if (directory === null) return;
  if (dumpInstalled) throw new Error('installWorkCounterDump was called twice in one process');
  dumpInstalled = true;
  // A directory that could not be made is reported here, once; an exit write
  // into it would only report the same failure again.
  if (!ensureTimingDirectory(DUMP_NOUN, directory)) return;
  process.on('exit', () => {
    writeTimingDump(DUMP_NOUN, directory, DUMP_BASENAME, () => buildDump(role));
  });
}

/**
 * TEST ONLY. Zero every counter, lift a {@link forbidWorkCounting} and the
 * test throw, forget an installed dump, and tell every
 * {@link onWorkCountersReset} listener.
 */
export function __resetWorkCountersForTest(): void {
  counts.fill(0);
  forbidden = false;
  reportedForbidden = false;
  throwOnForbidden = false;
  dumpInstalled = false;
  for (const listener of resetListeners) listener();
}

/**
 * TEST ONLY. Make a count on a thread that forbids counting throw, so a test
 * catches a site counting on the wrong side of a thread boundary. Lifted by
 * {@link __resetWorkCountersForTest}.
 */
export function throwOnForbiddenWorkCountForTest(): void {
  throwOnForbidden = true;
}

/**
 * TEST ONLY. The body the exit write would file now, without writing it.
 *
 * @param role - Which entry point to name
 * @returns The dump body
 */
export function __readWorkCounterDumpForTest(role: WorkCounterRole): WorkCounterDump {
  return buildDump(role);
}
