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
 * variable changes that. A test that wants the throw turns it on through
 * `__throwOnForbiddenWorkCountForTest` on `./testing`, and because that flag is
 * per thread, the thread that starts a worker hands it over: it reads
 * {@link forbiddenWorkCountPolicy} and the worker passes what it was given to
 * {@link forbidWorkCounting}.
 */

import { toForwardSlash } from './path-core.js';
import { ensureTimingDirectory, normalizeTimingDirectory, writeTimingDump } from './timing-dump.js';

/**
 * Every work counter, in dump order. Closed: a new counter is a new entry here,
 * and the lab's schema follows from this tuple.
 *
 * `store.*` counts the file-backed fact store a warm run reads and writes:
 * `store.reads.extent` one per `FactStore.readExtent` (a miss included, since
 * the manifest was read), `store.reads.blob` one per `FactStore.readBlobFacts`
 * that asked for at least one key, `store.reads.useStampLost` one per served extent
 * read whose recency stamp SQLite refused (the read still served; the tree keeps its
 * previous use), and `store.rows.decoded.persistent` the rows
 * either decoded, `store.rows.decoded.repeated` those this process decoded before;
 * `hydration.*` counts loading the per-run run database a query's SQL runs on,
 * which I10 does not bound: one write per hydration that filled a relation, and
 * the rows of the relations the run's statements name, inserted (`hydration.rows.written`)
 * or copied from the store inside SQLite (`hydration.rows.copied`). `statement.explained`
 * counts every `EXPLAIN` the SQL gate prepares — one per gated statement, and
 * the four virtual-table reference reads each handle makes when it is opened.
 *
 * `blob.storeServed` counts the content keys a derivation serves from the stored blob
 * tier rather than extracting them; `harness.pairsDerived` counts the `(blob, harness)`
 * pairs the harness pass derives facts for, one per pair it derived, a refused or
 * unreadable pair not included. Together with the parse lookups they say what one
 * extent miss extracted and what it reused.
 *
 * `parse.cache.written` counts parse-cache entries whose write was reported, parent side only:
 * `ParseCache.setByKey`, and the pool's settlement of a worker's `stored` reply. A worker killed
 * after its entry reached the final path but before its reply arrived wrote an entry this does not
 * count, so it is a lower bound on the entries written, exact when no worker died mid-job.
 * `content.read` counts a member file's bytes read to be keyed (`readContentWithKey`),
 * one per read that returned bytes; a read refused at the input cap is
 * `parse.refused.inputCap.read` instead. `content.gitRead` counts an object's bytes read from git's
 * object store instead (`GitObjectReaders.read`), one per object returned, and `content.gitSized` an
 * object's size asked of it (`GitObjectReaders.size`), one per size returned. `registry.built` counts every resource
 * registry constructed, and `registry.admitted` every resource a registry admitted
 * from disk (a crawl or `addResource`), never one handed to `fromResources`.
 * The `fs.*` counters count syscalls on the admission path, each at its call,
 * and only there: `fs.stat` counts the registry's `stat` of each file it
 * prepares, a realization's followed `stat` of a link, and the warm
 * admission's readability probe (an open and a close, counted as the stat it
 * stands in for); `fs.lstat` counts a realization's own `lstat` of its path,
 * and every `lstat` the link-chain walk (`hostPlaceKind`) makes: per path, the
 * components walked below the root plus one per link hop followed. A direct
 * `stat` or `lstat` elsewhere is not counted. The one member read neither
 * sees is the skills lane's `readFileSync` of a file it scans
 * (`skill-text-lane.ts`), whose own `fstat` happens inside Node, uncounted.
 * Together they let a test pin rule 4 of "Decision: content identity is per
 * source" (docs/architecture/content-keying-and-git.md): one read, one key and
 * one admission per file per run.
 *
 * `skillText.*` counts the skills lane's scans, once per (run, file) however many skills reach
 * the file. `storeMiss`: scanned from its text in a run with a store
 * (`ResourcePopulationSource.holdsStore`) because the source answered no stored document: on a hit,
 * the files the store does not cover; on a miss, the files the run's own derived population does
 * not cover (a miss answers from the rows it derived). `noStore`: scanned because the run has
 * no store (`vat audit`, the store off, or no run); never beside `storeMiss`. `storeUnopened`: once
 * per run at most, when the stored-document questions met a failure opening the store or building
 * the home population (a read-only cache, the store's lock held, git giving no answer); every scan
 * then is a `storeMiss`. `outsideRoot`: a question about a file outside the run's root, answered
 * nothing without opening the store, and also a `storeMiss` (or `noStore`) when scanned.
 *
 * `git.snapshots` counts `gitTreeSnapshot` memo misses, one per snapshot however many git
 * processes it starts.
 *
 * `checks.gate.rows.read` counts the tier rows the admission request reads for the checks overlap
 * gate, summed per member (resource-scanning-and-caching.md 3.7b).
 *
 * `collection.matchers.compiled` counts every collection whose include/exclude patterns are
 * compiled to a matcher (`compileCollectionMatcher`, the one place a collection's globs are
 * compiled): once per collection per holder of the config (a registry, a MIME resolver, a scoped
 * filter), never once per file matched.
 *
 * `rowSet.*` counts the row-set tier (the `data` instance's stored rows), only in a run whose
 * statements name a row-set relation or a derived relation a row-set instance produces:
 * `rowSet.extracted` one per row set extracted from its bytes; `rowSet.storeServed` one per
 * row set the coverage read found stored (paths with the same bytes and variant share one row set); `rowSet.refused` one per routed pair that is
 * defective or refused; `rowSet.rows.decoded` the row-set rows decoded into JavaScript from the
 * store, head rows included. A copy counts in `hydration.rows.copied`, a repeat decode in
 * `store.rows.decoded.repeated`.
 */
export const WORK_COUNTER_NAMES = [
  'store.rows.decoded.persistent',
  'store.rows.decoded.repeated',
  'store.reads.extent',
  'store.reads.blob',
  'store.reads.useStampLost',
  'store.writes.persistent',
  'store.rows.written.persistent',
  'hydration.writes',
  'hydration.rows.written',
  'hydration.rows.copied',
  'statement.explained',
  'extent.derived',
  'extent.served',
  'blob.storeServed',
  'harness.pairsDerived',
  'store.miss.refusedPairs',
  'parse.cache.hit',
  'parse.cache.written',
  'parse.dispatched',
  'parse.redispatched',
  'parse.refused.keyDetermined',
  'parse.refused.inputCap.read',
  'parse.refused.inputCap.dispatch',
  'parse.refused.load',
  'content.hashed',
  'content.hashedBytes',
  'content.read',
  'content.gitRead',
  'content.gitSized',
  'fs.stat',
  'fs.lstat',
  'registry.built',
  'registry.admitted',
  'skillText.storeMiss',
  'skillText.noStore',
  'skillText.storeUnopened',
  'skillText.outsideRoot',
  'git.calls',
  'git.snapshots',
  'checks.gate.rows.read',
  'collection.matchers.compiled',
  'rowSet.extracted',
  'rowSet.storeServed',
  'rowSet.refused',
  'rowSet.rows.decoded',
] as const;

/**
 * What a thread that forbids counting does with a count: report it once and
 * drop it (production), or throw (a test that turned the throw on).
 */
export type ForbiddenWorkCountPolicy = 'report' | 'throw';

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
  /**
   * The same counts split by the phase they were counted in ({@link withWorkPhase}),
   * one entry per phase that ran; work outside every phase is in `counters` only.
   */
  readonly phases: Readonly<Record<string, Readonly<Record<WorkCounter, number>>>>;
}

/** The variable naming the directory a process writes its dump to. Counting does not depend on it. */
export const WORK_COUNTERS_ENV = 'VAT_WORK_COUNTERS';

/**
 * The variable naming the directory a process writes its git spawn log to: every git process the
 * process started, in order, with its arguments, working directory and phase. Counting `git.calls`
 * does not depend on it, as counting does not depend on {@link WORK_COUNTERS_ENV}; recording each
 * spawn's details does, so a process with no log holds none.
 */
export const GIT_SPAWNS_ENV = 'VAT_GIT_SPAWNS';

/**
 * One git process a VAT process started, counted as one `git.calls` ({@link countGitSpawn}).
 *
 * - `runGit`: one `git <args>` (`runGit`, `runGitBytes`), run in `cwd`.
 * - `snapshot`: one `getGitTreeSnapshot` from `@vibe-validate/git`, which starts several git
 *   processes of its own (`rev-parse`, `add --all` into a temporary index, `ls-files -s`,
 *   `write-tree`); `args` is empty, because they are not VAT's to name.
 * - `objectReader`: one long-lived `git cat-file --batch-command` (`openGitObjectReaders`), run at
 *   the repository root, or on a git before 2.36 one `--batch-check` for sizes and one `--batch` for
 *   bytes; each answers every ask of its kind at that root until it is retired or closed.
 */
export interface GitSpawn {
  readonly via: 'runGit' | 'snapshot' | 'objectReader';
  readonly args: readonly string[];
  /** Where it ran; the log records it forward-slashed ({@link toForwardSlash}). */
  readonly cwd: string;
}

/** A {@link GitSpawn} as the log records it: with the phase it ran in, `null` outside every phase. */
export interface LoggedGitSpawn extends GitSpawn {
  readonly phase: string | null;
}

/** One process's git spawn log, as {@link GIT_SPAWNS_ENV} files it. */
export interface GitSpawnDump {
  readonly pid: number;
  readonly role: WorkCounterRole;
  readonly spawns: readonly LoggedGitSpawn[];
}

/** What the seam is called in a failure line. */
const DUMP_NOUN = 'work-counter';

/** What the git spawn log is called in a failure line. */
const SPAWN_DUMP_NOUN = 'git-spawn';

/** Basename stem of a git spawn log; the pid and any collision counter follow it. */
const SPAWN_DUMP_BASENAME = 'git-spawns';

/** Basename stem of a dump; the pid and any collision counter follow it. */
const DUMP_BASENAME = 'work-counters';

/** Each counter's slot in {@link counts}. */
const SLOT = new Map<string, number>(WORK_COUNTER_NAMES.map((name, slot) => [name, slot]));

/** The counts, one slot per {@link WORK_COUNTER_NAMES} entry. Per thread, as every module state is. */
const counts = new Float64Array(WORK_COUNTER_NAMES.length);

/** Each phase's counts, by phase name, in the order the phases first ran. */
const phaseCounts = new Map<string, Float64Array>();

/** The phase counting now, if any ({@link withWorkPhase}). */
let currentPhase: Float64Array | null = null;

/** The name of {@link currentPhase}, for the git spawn log. */
let currentPhaseName: string | null = null;

/**
 * Every git process this thread started, in order ({@link countGitSpawn}), while
 * {@link spawnLogInstalled}: a process with no log holds no details, so nothing grows for its life.
 */
const gitSpawns: LoggedGitSpawn[] = [];

/** Whether {@link installWorkCounterDump} installed the git spawn log ({@link GIT_SPAWNS_ENV} set). */
let spawnLogInstalled = false;

/** Set by {@link forbidWorkCounting}: this thread's work is counted by another. */
let forbidden = false;

/** What {@link forbidWorkCounting} said to do with a count here. */
let forbiddenPolicy: ForbiddenWorkCountPolicy = 'report';

/** Whether this thread has already reported a forbidden count. Once per thread. */
let reportedForbidden = false;

/** Set only by {@link __throwOnForbiddenWorkCountForTest}: threads this one starts throw on a count. */
let throwOnForbidden = false;

/** Whether {@link installWorkCounterDump} has been called with the dump on. */
let dumpInstalled = false;

/** See {@link workCountsObserved}. */
let countsObserved = false;

/** The exit writes {@link installWorkCounterDump} registered, so a test reset can take them back. */
const dumpListeners: Array<() => void> = [];

/**
 * Count `n` units of work against one counter.
 *
 * @param counter - Which counter; never `git.calls`, which only {@link countGitSpawn} counts
 * @param n - How many: a non-negative integer, never defaulted
 * @throws RangeError for a name outside {@link WORK_COUNTER_NAMES}, for
 *   `git.calls` (an untyped caller), or for an `n` that is not a count; Error for
 *   a count on a thread that forbids counting with the `throw` policy
 */
export function countWork(counter: Exclude<WorkCounter, 'git.calls'>, n: number): void {
  if ((counter as WorkCounter) === 'git.calls') throw new RangeError("'git.calls' is counted by countGitSpawn, which names the spawn");
  add(counter, n);
}

/** Set `true` by the repo's shared vitest setup, which imports no package. */
const OBSERVED_BY_TEST_SETUP = '__vatWorkCountsObserved';

/**
 * Whether anything will read this thread's counts, so work kept only to be counted (the store's
 * record of every row it decoded) costs nothing when no reader observes. Set by the dump's install,
 * an in-process read, a test reset, or {@link OBSERVED_BY_TEST_SETUP}. Gated work done before the
 * first read is not kept: the parse-timing dump turns the ledger on mid-run, from its read.
 *
 * @returns True when anything observes this thread's counts
 */
export function workCountsObserved(): boolean {
  return countsObserved || (globalThis as Record<string, unknown>)[OBSERVED_BY_TEST_SETUP] === true;
}

/**
 * Count one git process (`git.calls`) and, when the spawn log is installed ({@link GIT_SPAWNS_ENV}),
 * log it: what it ran, where, and in which phase. The one way `git.calls` is counted, so every
 * counted spawn is one a log could name.
 *
 * @param spawn - The process, every field stated
 * @throws As {@link countWork} does
 */
export function countGitSpawn(spawn: GitSpawn): void {
  add('git.calls', 1);
  // Every logged directory forward-slashed here, whichever site spelled it (a caller's, or
  // `runGit`'s `process.cwd()` fallback, native on Windows).
  if (!forbidden && spawnLogInstalled) gitSpawns.push({ via: spawn.via, args: [...spawn.args], cwd: toForwardSlash(spawn.cwd), phase: currentPhaseName });
}

/**
 * The body of {@link countWork}, for any counter.
 *
 * @param counter - Which counter
 * @param n - How many
 */
function add(counter: WorkCounter, n: number): void {
  const slot = SLOT.get(counter);
  if (slot === undefined) throw new RangeError(`'${String(counter)}' is not a work counter`);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`work counter '${counter}' was given ${String(n)}, which is not a non-negative integer`);
  }
  if (forbidden) {
    const finding = `work counter '${counter}' counted on a thread that forbids work counting (its parent counts this work)`;
    if (forbiddenPolicy === 'throw') throw new Error(finding);
    if (!reportedForbidden) {
      reportedForbidden = true;
      process.stderr.write(`vat: ${finding}; not counted\n`);
    }
    return;
  }
  counts[slot] = (counts[slot] ?? 0) + n;
  if (currentPhase !== null) currentPhase[slot] = (currentPhase[slot] ?? 0) + n;
}

/**
 * Attribute every count `work` makes to a named phase as well as to the process.
 *
 * Phases are sequential: a phase opened inside another replaces it for its
 * duration and restores it after, so an orchestrator that awaits one phase
 * before the next attributes each count to exactly one phase. Counting stays on
 * either way; the phase only adds a split to the dump.
 *
 * @param phase - The phase's name, as the dump reports it
 * @param work - The phase's work
 * @returns Whatever `work` returned
 */
export async function withWorkPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  let slots = phaseCounts.get(phase);
  if (slots === undefined) {
    slots = new Float64Array(WORK_COUNTER_NAMES.length);
    phaseCounts.set(phase, slots);
  }
  const outer = currentPhase;
  const outerName = currentPhaseName;
  currentPhase = slots;
  currentPhaseName = phase;
  try {
    return await work();
  } finally {
    currentPhase = outer;
    currentPhaseName = outerName;
  }
}

/**
 * One slot array as a record, every counter present.
 *
 * @param slots - Counts by slot
 * @returns Counts by name
 */
function countsOf(slots: Float64Array): Record<WorkCounter, number> {
  return Object.fromEntries(WORK_COUNTER_NAMES.map((name, slot) => [name, slots[slot] ?? 0])) as Record<
    WorkCounter,
    number
  >;
}

/**
 * This thread's counts, every counter present, zeros included.
 *
 * @returns A snapshot; later counts do not change it
 */
export function readWorkCounters(): Readonly<Record<WorkCounter, number>> {
  countsObserved = true;
  return countsOf(counts);
}

/**
 * This thread's counts per phase ({@link withWorkPhase}).
 *
 * @returns A snapshot, one entry per phase that has run
 */
function readWorkCountersByPhase(): Readonly<Record<string, Readonly<Record<WorkCounter, number>>>> {
  return Object.fromEntries([...phaseCounts].map(([phase, slots]) => [phase, countsOf(slots)]));
}

/**
 * Declare that this thread's work is counted by another thread — see the
 * module header. Called once at a worker's startup.
 *
 * @param policy - What a count here does: what the starting thread's
 *   {@link forbiddenWorkCountPolicy} said, handed over at the worker's start
 */
export function forbidWorkCounting(policy: ForbiddenWorkCountPolicy): void {
  forbidden = true;
  forbiddenPolicy = policy;
}

/**
 * What a thread this one starts should do with a count, once it forbids
 * counting: `throw` only after a test called `__throwOnForbiddenWorkCountForTest`
 * here, so the throw reaches across the thread boundary it guards.
 *
 * @returns The policy to hand the new thread
 */
export function forbiddenWorkCountPolicy(): ForbiddenWorkCountPolicy {
  return throwOnForbidden ? 'throw' : 'report';
}

/**
 * Build this process's dump body.
 *
 * @param role - Which process is writing it
 * @returns The body
 */
function buildDump(role: WorkCounterRole): WorkCounterDump {
  return { pid: process.pid, role, counters: readWorkCounters(), phases: readWorkCountersByPhase() };
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
  const counts = normalizeTimingDirectory(process.env[WORK_COUNTERS_ENV]);
  const spawns = normalizeTimingDirectory(process.env[GIT_SPAWNS_ENV]);
  if (counts === null && spawns === null) return;
  if (dumpInstalled) throw new Error('installWorkCounterDump was called twice in one process');
  dumpInstalled = true;
  if (counts !== null) {
    countsObserved = true;
    onExitWrite(DUMP_NOUN, counts, DUMP_BASENAME, () => buildDump(role));
  }
  if (spawns !== null) {
    spawnLogInstalled = true;
    onExitWrite(SPAWN_DUMP_NOUN, spawns, SPAWN_DUMP_BASENAME, (): GitSpawnDump => ({ pid: process.pid, role, spawns: readGitSpawns() }));
  }
}

/**
 * Register one dump's exit write.
 *
 * @param noun - What the dump is called in a failure line
 * @param directory - Where it goes
 * @param basename - Its basename stem
 * @param body - Its body, built at exit
 */
function onExitWrite(noun: string, directory: string, basename: string, body: () => object): void {
  // A directory that could not be made is reported here, once; an exit write
  // into it would only report the same failure again.
  const made = ensureTimingDirectory(noun, directory);
  if (made === null) return;
  const listener = (): void => {
    writeTimingDump(noun, made, basename, body);
  };
  dumpListeners.push(listener);
  process.on('exit', listener);
}

/**
 * This thread's git spawn log ({@link countGitSpawn}).
 *
 * @returns A snapshot; later spawns do not change it
 */
export function readGitSpawns(): readonly LoggedGitSpawn[] {
  return [...gitSpawns];
}

/**
 * TEST ONLY. Zero every counter, lift a {@link forbidWorkCounting} and the
 * test throw, and take back an installed dump's exit write.
 */
export function __resetWorkCountersForTest(): void {
  counts.fill(0);
  phaseCounts.clear();
  currentPhase = null;
  currentPhaseName = null;
  gitSpawns.length = 0;
  spawnLogInstalled = false;
  forbidden = false;
  forbiddenPolicy = 'report';
  reportedForbidden = false;
  throwOnForbidden = false;
  dumpInstalled = false;
  countsObserved = true;
  for (const listener of dumpListeners) process.off('exit', listener);
  dumpListeners.length = 0;
}

/**
 * TEST ONLY. Make every thread this one starts from now on throw on a count
 * once it forbids counting ({@link forbiddenWorkCountPolicy}), so a test
 * catches a site counting on the wrong side of a thread boundary. Lifted by
 * {@link __resetWorkCountersForTest}.
 */
export function __throwOnForbiddenWorkCountForTest(): void {
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
