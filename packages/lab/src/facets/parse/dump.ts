/**
 * Reading the parse-timing seam's dumps and merging them into one command's
 * numbers.
 *
 * The seam lives inside vat: when {@link PARSE_TIMING_DIR_ENV} names a
 * directory, every vat process that parses a document writes one JSON file there
 * at exit. The file plumbing — read every dump, refuse a malformed or
 * wrong-version one, refuse an empty directory rather than reporting zero —
 * belongs to `harness/dumps.ts` and is shared with the `io` facet. What is here
 * is the part that is only true of parse timings.
 *
 * ## Why the env-var name and the dump shape are declared HERE
 *
 * Not imported from `@vibe-agent-toolkit/resources`, even though that package
 * writes the file. The whole point of the facet is A/B — and **an arm of an A/B
 * may be a vat build that has no seam at all**, which is exactly the state the
 * current baseline build is in. A lab that imported the contract from the
 * package under measurement could not be built against a version that predates
 * it, and the facet has to be able to point at either arm and refuse cleanly
 * rather than fail to compile. The `io` facet pins `VAT_LAB_IO_LOG` as a literal
 * on both sides for the same reason; `test/parse-dump.test.ts` pins this one.
 *
 * ## One group per parser kind, and why the totals are not rows
 *
 * vat parses more than one kind of document and the kinds share no passes, so
 * the dump groups them: each group carries its own documents, its own passes and
 * its own bracketing total. The total is a **field beside the rows, never a row
 * among them**, which is what makes a wrong remainder unconstructible — there is
 * no way to sum the rows in front of you and accidentally fold a bracket into
 * the sum, and the only total a group's rows can be measured against is its own.
 *
 * The kind NAMES and the pass names are deliberately not pinned by this reader.
 * A build that grows a third parser kind, or splits a pass, must not make every
 * dump unreadable; what is pinned is the structural property that each group
 * brackets itself, and the per-kind remainder keeps the arithmetic honest when
 * the shape moves.
 *
 * ## One dump per PROCESS, carrying every thread of it
 *
 * A dump is a process: its lifetime once, and a record per thread that
 * accumulated anything. A pooled run is one file holding a main thread and up to
 * eight parse workers; `processes: 1` is the expected reading for every command.
 * A report showing more than one process is measuring something the harness
 * normally skips — the shipped `vat` wrapper (`packages/cli/src/bin/vat.ts`)
 * spawns `bin.js`, and the harness drives `dist/bin.js` directly to avoid it.
 *
 * The split is what the two kinds of number require. `process.uptime()` and
 * `process.cpuUsage()` are the PROCESS's, so they are read once, by the thread
 * that writes the file, and summing them across threads would multiply one
 * lifetime by the pool's width. Everything a thread measured for itself — its
 * documents, its bytes, its pass calls and elapsed time, its cache outcomes — is
 * disjoint per thread and sums.
 *
 * ⚠️ That makes `elapsedMs` **time spent in that pass across the run** and
 * emphatically not wall time: eight workers running concurrently still add their
 * milliseconds, so a run that got FASTER by keeping more threads busy reports a
 * LARGER total. Read it as a share of its group's total, which is summed the
 * same way and therefore stays a valid denominator, and read
 * {@link MergedParseDumps.workerThreads} before quoting any of it.
 *
 * ## What is NOT an invariant
 *
 * The document counts and `cacheMisses` are **not** two names for one number and
 * nothing here derives either from the other. Every parser kind is now counted,
 * so the two populations are finally comparable — but several call sites reach a
 * parser without consulting the cache at all, so the parse counts can exceed the
 * misses. That difference is published as {@link MergedParseDumps.uncachedParses}
 * and labelled as the *remainder* it is, under the same discipline
 * `unattributedMs` is: derive it here, never let the seam pretend it measured it,
 * and never clamp it.
 */

import { z } from 'zod';

import { type DumpKind, type DumpsRefusal, readDumpFiles } from '../../harness/dumps.js';

import type { ParseAttribution, ParsePassStats } from './types.js';
import { parsePassShape } from './types.js';

/**
 * The variable that switches the seam on, and whose VALUE is the directory the
 * dumps are written to.
 *
 * A literal, deliberately not imported — see this module's header.
 */
export const PARSE_TIMING_DIR_ENV = 'VAT_PARSE_TIMING';

/**
 * What a kind's bracketing total is called.
 *
 * Self-describing rather than a bare `total`, so a row lifted out of its group
 * still says which bracket it is — and so no kind's total can be mistaken for
 * "the" total the way a single markdown-only `total` silently was.
 *
 * @param kind - The parser kind
 * @returns The name that kind's total must carry
 */
export function parseTotalName(kind: string): string {
  return `${kind}-total`;
}

/** One pass row as the seam wrote it. */
export interface ParseDumpPass {
  readonly pass: string;
  readonly calls: number;
  readonly elapsedMs: number;
}

/**
 * One process's wall and CPU time, as the seam read it at exit.
 *
 * Lifetime figures for the whole process, **not** for the parse. Their value is
 * the ratio: the passes are wall-timed (a per-pass CPU reading would be ~12,000
 * syscalls and would become the cost it measured), so a process whose CPU time
 * is far below its wall time was waiting, and every per-pass figure carries that
 * waiting inside it.
 */
export interface ParseDumpProcess {
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
}

/** One parser kind's group within a dump. */
export interface ParseDumpKind {
  readonly kind: string;
  readonly documents: { readonly count: number; readonly bytes: number };
  /** The bracket around this kind's whole parse. Never one of `passes`. */
  readonly total: ParseDumpPass;
  readonly passes: readonly ParseDumpPass[];
}

/** What ONE thread of a process accumulated. */
export interface ParseThreadDump {
  /**
   * Which thread of the enclosing {@link ParseDump.pid} this is: `0` on the main
   * thread, a positive integer in a parse worker.
   *
   * It is not needed for the parser kinds — a thread's documents and passes are
   * its own and sum correctly however they are grouped — but it is load-bearing
   * for the tier rows, where the whole question is whether a cost landed on the
   * serial main thread or on a parallel worker.
   */
  readonly threadId: number;
  /** Parse-cache outcomes across every parser kind, on this thread. */
  readonly cache: { readonly hits: number; readonly misses: number };
  readonly kinds: readonly ParseDumpKind[];
  /**
   * Work the parse TIER did around the parses — cache reads and writes, boundary
   * crossings — never a parser pass and never inside a kind group.
   */
  readonly tier: readonly ParseDumpPass[];
}

/**
 * One PROCESS's dump: its lifetime, and every thread of it.
 *
 * Thread structure is DATA here, never inferred from how many files landed on
 * disk. A count of files can only say how many writers there were; it cannot say
 * which of them was the parent, and it cannot stop a reader summing one
 * process's lifetime once per thread — an error whose magnitude is exactly the
 * pool's width and which reads as a performance regression that never happened.
 */
export interface ParseDump {
  readonly pid: number;
  readonly process: ParseDumpProcess;
  /**
   * Every thread of this process that accumulated anything, main thread first
   * and always present.
   *
   * A worker appears only if it answered the pool's shutdown request; one wedged
   * badly enough to be `terminate()`d is simply absent, which shows up as a
   * thread count below the pool's width.
   */
  readonly threads: readonly ParseThreadDump[];
}

/** What a dump with no parser kinds at all is rejected with. */
const NO_KINDS_MESSAGE =
  'a dump must carry at least one parser kind, each bracketing itself — without a group there ' +
  'is no denominator for a share and no way to tell attributed time from time nothing ' +
  'accounted for';

/** What a group whose total does not name its own kind is rejected with. */
const MISLABELLED_TOTAL_MESSAGE =
  "each kind's total must be named '<kind>-total' — a bracket that does not say which parse it " +
  'brackets is one a reader can charge the wrong rows against';

/** What a dump naming one pass twice within a group is rejected with. */
const DUPLICATE_PASS_MESSAGE =
  'a dump must name each pass once within its kind; two rows for one pass would be summed into ' +
  'a number whose meaning depends on which row the seam wrote first';

/** What a dump naming one parser kind twice is rejected with. */
const DUPLICATE_KIND_MESSAGE =
  'a dump must name each parser kind once; two groups for one kind would each look like the ' +
  'whole of that kind';

/**
 * Does every group carry exactly one row per pass, and a total that is not one
 * of them?
 *
 * @param dump - The dump being validated
 * @returns True when every group's pass names are distinct from each other and
 *   from its total
 */
function passNamesAreUnique(dump: { readonly kinds: readonly ParseDumpKind[] }): boolean {
  return dump.kinds.every((group) => {
    const names = new Set(group.passes.map((pass) => pass.pass));
    return names.size === group.passes.length && !names.has(group.total.pass);
  });
}

/**
 * Does each group's total name its own kind?
 *
 * @param dump - The dump being validated
 * @returns True when every total is `<kind>-total`
 */
function totalsNameTheirKind(dump: { readonly kinds: readonly ParseDumpKind[] }): boolean {
  return dump.kinds.every((group) => group.total.pass === parseTotalName(group.kind));
}

/**
 * Is each parser kind named once?
 *
 * @param dump - The dump being validated
 * @returns True when every group's kind is distinct
 */
function kindNamesAreUnique(dump: { readonly kinds: readonly ParseDumpKind[] }): boolean {
  return new Set(dump.kinds.map((group) => group.kind)).size === dump.kinds.length;
}

/** A non-negative whole number, as every count in a dump must be. */
const wholeCount = z.number().int().nonnegative();

/** A duration in milliseconds. Unrounded and unbounded, exactly as the seam wrote it. */
const durationMs = z.number().nonnegative();

/** One pass row, shared by a group's `passes` and its `total`. */
const passRowSchema = z.object(parsePassShape).strict();

/** What a dump naming one tier pass twice is rejected with. */
const DUPLICATE_TIER_MESSAGE =
  'a dump must name each tier pass once; two rows for one pass would be summed into a number ' +
  'whose meaning depends on which row the seam wrote first';

/**
 * Is each tier pass named once?
 *
 * @param dump - The dump being validated
 * @returns True when every tier row's name is distinct
 */
function tierNamesAreUnique(dump: { readonly tier: readonly ParseDumpPass[] }): boolean {
  return new Set(dump.tier.map((row) => row.pass)).size === dump.tier.length;
}

/** What a dump carrying no thread at all is rejected with. */
const NO_THREADS_MESSAGE =
  'a dump must carry at least the thread that wrote it — a process that reports a lifetime and ' +
  'no threads has published a denominator with nothing to divide into it';

/** Runtime schema for {@link ParseThreadDump}. */
const threadDumpSchema = z
  .object({
    threadId: wholeCount,
    cache: z.object({ hits: wholeCount, misses: wholeCount }).strict(),
    kinds: z
      .array(
        z
          .object({
            kind: z.string().min(1),
            documents: z.object({ count: wholeCount, bytes: wholeCount }).strict(),
            total: passRowSchema,
            passes: z.array(passRowSchema),
          })
          .strict(),
      )
      .min(1, { message: NO_KINDS_MESSAGE }),
    // No `.min(1)`, unlike `kinds`. A kind group is the denominator for a share,
    // so a dump with none of them can state no share at all; a tier row is an
    // absolute cost that stands alone, and a build whose tier does nothing has
    // nothing to say rather than something to hide.
    tier: z.array(passRowSchema),
  })
  .strict()
  .refine(totalsNameTheirKind, { message: MISLABELLED_TOTAL_MESSAGE })
  .refine(passNamesAreUnique, { message: DUPLICATE_PASS_MESSAGE })
  .refine(kindNamesAreUnique, { message: DUPLICATE_KIND_MESSAGE })
  .refine(tierNamesAreUnique, { message: DUPLICATE_TIER_MESSAGE });

/** Runtime schema for {@link ParseDump}. Strict: the seam is ours, so an unknown field is a bug. */
export const ParseDumpSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    process: z
      .object({ wallMs: durationMs, cpuUserMs: durationMs, cpuSystemMs: durationMs })
      .strict(),
    threads: z.array(threadDumpSchema).min(1, { message: NO_THREADS_MESSAGE }),
  })
  .strict();

/** One parser kind's merged numbers. */
export interface MergedParseKind {
  readonly kind: string;
  /** Documents this parser ran over. */
  readonly documents: number;
  readonly bytes: number;
  /** The attributed passes, in the order the seam first emitted them. */
  readonly passes: readonly ParsePassStats[];
  /** The bracketing row, kept apart so no sum over `passes` double-counts it. */
  readonly total: ParsePassStats;
  /** This kind's `total.elapsedMs` minus its own attributed passes. */
  readonly unattributedMs: number;
}

/**
 * One tier pass, merged, split by which side of the boundary paid for it.
 *
 * ## Why a main-thread share and not just a total
 *
 * Every tier row is a cost, and the only question the parse tier's design turns
 * on is WHERE a cost lands. The wire transport and the cache transport move the
 * same three operations — serialize the facts, write the entry, read it back —
 * between the parent and its workers in opposite directions, so the two arms can
 * report near-identical totals while being completely different runs: one has
 * the parent doing it all serially, the other has eight threads doing most of it
 * at once. A merge that published only `elapsedMs` would show that as no change
 * at all.
 *
 * `mainElapsedMs` is therefore the number to read first. It is the part charged
 * to the one thread Amdahl's law is about.
 */
export interface TierPassStats {
  /** The seam's own name — `cache-read-io`, `wire-dispatch`. Never pinned by this build. */
  readonly pass: string;
  /** How many times the bracket ran, across every thread. */
  readonly calls: number;
  /** Time inside the bracket, summed across every thread. Not wall time. */
  readonly elapsedMs: number;
  /** Of {@link TierPassStats.calls}, those charged on a MAIN thread (`threadId` 0). */
  readonly mainCalls: number;
  /**
   * Of {@link TierPassStats.elapsedMs}, the share charged on a MAIN thread.
   *
   * Read this before the total. See the interface docstring.
   */
  readonly mainElapsedMs: number;
}

/** Every dump from one command run, merged. */
export interface MergedParseDumps {
  /**
   * Processes that wrote a dump, counted as FILES rather than as distinct pids.
   *
   * Pids are reused, so a pid set would fold two sequential processes into one —
   * an undercount nothing downstream could detect. One file is one process by
   * construction, so counting files is exact.
   */
  readonly processes: number;
  /**
   * Main threads that reported — one per process, and the denominator for every
   * `mainElapsedMs`.
   */
  readonly mainThreads: number;
  /**
   * Parse worker threads that reported.
   *
   * The denominator for worker utilization (`worker-job` elapsed ÷ wall ÷ this),
   * and the number to read before quoting any `elapsedMs` on this row, all of
   * which are summed across these threads.
   *
   * ⚠️ Threads that REPORTED, not threads that ran: a worker only hands its
   * counters over when the pool asks it to shut down, so one wedged past
   * `GRACEFUL_EXIT_TIMEOUT_MS` is absent. A count below the pool's width is the
   * tell, and it matters because this is a denominator.
   */
  readonly workerThreads: number;
  /** One entry per parser kind the dumps carried, in first-appearance order. */
  readonly kinds: readonly MergedParseKind[];
  /**
   * One entry per tier pass, in first-appearance order.
   *
   * Beside `kinds` and never folded into it: these are not parser passes, and a
   * reader summing them into a kind's total would be computing a share of a
   * denominator they do not belong to. See {@link TierPassStats}.
   */
  readonly tier: readonly TierPassStats[];
  /** Documents parsed across every kind. */
  readonly documents: number;
  readonly bytes: number;
  /** Cache hits across every parser kind — see this module's header. */
  readonly cacheHits: number;
  readonly cacheMisses: number;
  /**
   * Parses that never consulted the cache: total documents minus cache misses.
   *
   * **A remainder of independently measured counters, not a counter.** Every
   * parse increments exactly one kind's document count, and every parse routed
   * through the cache increments `cacheMisses` first, so what is left over is
   * the parses that reached a parser by another route — `parseMarkdown(path)`
   * and `parseHtml(path)` read and parse without consulting the cache at all.
   *
   * Signed and never clamped, for the same reason `unattributedMs` is: negative
   * means more misses were counted than parses completed, which is a parse that
   * threw, and a reader has to see that rather than have it tidied into a
   * reassuring `0`.
   */
  readonly uncachedParses: number;
  /** Calls to a parser, across every kind. */
  readonly totalCalls: number;
  /** Time inside a parser, across every kind — the whole parse budget. */
  readonly totalMs: number;
  /** Every kind's unattributed remainder, summed. */
  readonly unattributedMs: number;
  /**
   * Process lifetime wall clock: ONE reading per pid, summed across pids.
   *
   * Not a parse duration, and not a sum over dump files — see this module's
   * header and {@link addLifetime}.
   */
  readonly wallMs: number;
  /** User CPU, one reading per pid, summed across pids. See {@link MergedParseDumps.wallMs}. */
  readonly cpuUserMs: number;
  /** System CPU, one reading per pid, summed across pids. See {@link MergedParseDumps.wallMs}. */
  readonly cpuSystemMs: number;
}

/** A merge that succeeded. */
export interface ParseDumpsAccepted {
  readonly ok: true;
  readonly merged: MergedParseDumps;
}

/** The outcome of reading a directory of parse-timing dumps. */
export type MergedParseDumpsResult = ParseDumpsAccepted | DumpsRefusal;

/** Mutable accumulator behind one merged pass. */
interface PassBucket {
  readonly pass: string;
  calls: number;
  elapsedMs: number;
}

/** Mutable accumulator behind one merged tier pass. */
interface TierBucket {
  readonly pass: string;
  calls: number;
  elapsedMs: number;
  mainCalls: number;
  mainElapsedMs: number;
}

/** Mutable accumulator behind one merged parser kind. */
interface KindBucket {
  readonly kind: string;
  documents: number;
  bytes: number;
  readonly total: PassBucket;
  readonly passes: Map<string, PassBucket>;
}

/**
 * The process-level scalars a merge SUMS over every dump file, in one bag.
 *
 * The per-kind numbers are not here — they belong to their group. Neither are
 * the lifetimes: those are the one thing on a dump that describes the process
 * rather than the work, so N dumps from one pid repeat them instead of
 * partitioning them. See {@link addLifetime}.
 *
 * The cache split stays here and stays summed. Each thread consults its own
 * parse cache and counts its own outcomes, so those really are disjoint — in
 * the run that exposed the lifetime defect the parent counted 1,805 misses and
 * the eight workers counted none, and dropping any dump's contribution would
 * have deleted most of the parses the facet exists to attribute.
 */
interface DumpTotals {
  cacheHits: number;
  cacheMisses: number;
}

/** One process's lifetime, as the dumps that share its pid report it. */
interface LifetimeBucket {
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

/**
 * What the shared dump reader needs to know about a parse-timing dump.
 *
 * The empty-directory sentence is this facet's own because the *lie* it prevents
 * is: for `io` a missing dump would read as "vat touched nothing", here it would
 * read as "parsing was free" — and, far more likely, it means the vat build
 * being measured has no seam in it at all.
 */
const PARSE_DUMP_KIND: DumpKind<ParseDump> = {
  noun: 'parse-timing dump',
  producer: 'timing seam',
  schema: ParseDumpSchema,
  emptyDirectory: (directory) =>
    `no parse-timing dumps in '${directory}'. Nothing wrote one, so there is no measurement — ` +
    `the usual cause is a vat build with no timing seam in it (it is switched on by ` +
    `${PARSE_TIMING_DIR_ENV}, and a build that predates the seam ignores it). Reporting zero ` +
    'milliseconds here would say parsing was free.',
};

/**
 * Add one pass row into a group's buckets.
 *
 * @param into - The group's pass buckets, mutated in place
 * @param row - The row to fold in
 */
function addPassRow(into: Map<string, PassBucket>, row: ParseDumpPass): void {
  const bucket = into.get(row.pass);
  if (bucket === undefined) {
    into.set(row.pass, { pass: row.pass, calls: row.calls, elapsedMs: row.elapsedMs });
    return;
  }
  bucket.calls += row.calls;
  bucket.elapsedMs += row.elapsedMs;
}

/**
 * Add one process's group for a kind into the running buckets.
 *
 * @param byKind - Every kind's bucket, mutated in place
 * @param group - One process's group for one kind
 */
function addKindGroup(byKind: Map<string, KindBucket>, group: ParseDumpKind): void {
  let bucket = byKind.get(group.kind);
  if (bucket === undefined) {
    bucket = {
      kind: group.kind,
      documents: 0,
      bytes: 0,
      total: { pass: group.total.pass, calls: 0, elapsedMs: 0 },
      passes: new Map<string, PassBucket>(),
    };
    byKind.set(group.kind, bucket);
  }
  bucket.documents += group.documents.count;
  bucket.bytes += group.documents.bytes;
  bucket.total.calls += group.total.calls;
  bucket.total.elapsedMs += group.total.elapsedMs;
  for (const row of group.passes) addPassRow(bucket.passes, row);
}

/**
 * Add one dump's tier rows into the running buckets.
 *
 * Charges the main-thread share from the thread's OWN `threadId` rather than
 * from anything derived: a worker and its parent share a pid, so there is no
 * other signal here that could tell them apart, and inferring one (say, "the
 * record with the longest lifetime is the parent") would be a guess dressed as a
 * measurement.
 *
 * @param into - Every tier pass's bucket, mutated in place
 * @param thread - One thread's counters
 */
function addTierRows(into: Map<string, TierBucket>, thread: ParseThreadDump): void {
  const onMainThread = thread.threadId === 0;
  for (const row of thread.tier) {
    let bucket = into.get(row.pass);
    if (bucket === undefined) {
      bucket = { pass: row.pass, calls: 0, elapsedMs: 0, mainCalls: 0, mainElapsedMs: 0 };
      into.set(row.pass, bucket);
    }
    bucket.calls += row.calls;
    bucket.elapsedMs += row.elapsedMs;
    if (onMainThread) {
      bucket.mainCalls += row.calls;
      bucket.mainElapsedMs += row.elapsedMs;
    }
  }
}

/**
 * Add one thread's non-parser counts to the running totals.
 *
 * Counts only, and every one of them is a thread's own, so they sum. The process
 * LIFETIMES are deliberately not here: they are read once per process by the
 * thread that writes the dump, and summing them over threads would multiply one
 * lifetime by the pool's width.
 *
 * @param totals - The bag being accumulated into, mutated in place
 * @param thread - One thread's counters
 */
function addThreadTotals(totals: DumpTotals, thread: ParseThreadDump): void {
  totals.cacheHits += thread.cache.hits;
  totals.cacheMisses += thread.cache.misses;
}

/**
 * Add one PROCESS's lifetime to the running total.
 *
 * A plain sum, and it is safe to be one because a process reports its lifetime
 * exactly once: `parse-timing.ts` reads `uptime()`/`cpuUsage()` on the single
 * thread that writes the file, so no arrangement of threads can present one
 * lifetime twice. That mattered — `render.ts` divides `cpu / wallMs` against
 * {@link CPU_BOUND_FLOOR}, so an inflated denominator deflates the trust signal
 * a reader uses to decide whether to believe the wall figures at all.
 *
 * ⛔ **What summing does NOT handle is several PROCESSES.** An orchestrator
 * alive for the whole run CONTAINS its children's lifetimes, so a sum
 * double-counts real time. Every vat command reports `processes: 1`, so the case
 * is vacant rather than solved, and it is left that way deliberately: `max` is
 * right only for a strictly-nested tree, parent-only needs a parent pid no dump
 * carries, and per-process ratios trade one number for N.
 *
 * @param into - The running lifetime, mutated in place
 * @param dump - One process's dump
 */
function addLifetime(into: LifetimeBucket, dump: ParseDump): void {
  into.wallMs += dump.process.wallMs;
  into.cpuUserMs += dump.process.cpuUserMs;
  into.cpuSystemMs += dump.process.cpuSystemMs;
}

/**
 * Close one kind's buckets into its published numbers.
 *
 * Pass order follows first appearance rather than cost, so the report reads in
 * pipeline order and two reports of the same run list their rows identically. A
 * sort by elapsed time would reorder the report every time the numbers moved,
 * which makes two reports impossible to read side by side.
 *
 * @param bucket - One kind's accumulator
 * @returns That kind's merged numbers
 */
function closeKind(bucket: KindBucket): MergedParseKind {
  const passes = [...bucket.passes.values()].map((pass) => ({ ...pass }));
  const attributedMs = passes.reduce((sum, pass) => sum + pass.elapsedMs, 0);
  return {
    kind: bucket.kind,
    documents: bucket.documents,
    bytes: bucket.bytes,
    passes,
    total: { ...bucket.total },
    // Never clamped at zero. The seam emits unrounded values precisely so this
    // stays computable, and a remainder that comes out negative is either float
    // noise (a few thousandths) or a broken bracketing — both of which a reader
    // needs to see rather than have tidied away into a reassuring `0`.
    unattributedMs: bucket.total.elapsedMs - attributedMs,
  };
}

/**
 * Sum one field across every kind.
 *
 * @param kinds - The merged kinds
 * @param pick - Which field to sum
 * @returns The sum, or `0` when there are no kinds
 */
function acrossKinds(
  kinds: readonly MergedParseKind[],
  pick: (kind: MergedParseKind) => number,
): number {
  return kinds.reduce((sum, kind) => sum + pick(kind), 0);
}

/**
 * Merge every process's dump from one command run.
 *
 * @param dumps - Every dump the run produced
 * @returns The merged numbers
 */
export function mergeParseDumps(dumps: readonly ParseDump[]): MergedParseDumps {
  const lifetime: LifetimeBucket = { wallMs: 0, cpuUserMs: 0, cpuSystemMs: 0 };
  const byKind = new Map<string, KindBucket>();
  const byTierPass = new Map<string, TierBucket>();
  const totals: DumpTotals = { cacheHits: 0, cacheMisses: 0 };
  let mainThreads = 0;
  let workerThreads = 0;

  for (const dump of dumps) {
    addLifetime(lifetime, dump);
    for (const thread of dump.threads) {
      if (thread.threadId === 0) mainThreads += 1;
      else workerThreads += 1;
      addThreadTotals(totals, thread);
      addTierRows(byTierPass, thread);
      for (const group of thread.kinds) addKindGroup(byKind, group);
    }
  }

  const kinds = [...byKind.values()].map((bucket) => closeKind(bucket));
  const documents = acrossKinds(kinds, (kind) => kind.documents);

  return {
    processes: dumps.length,
    mainThreads,
    workerThreads,
    kinds,
    tier: [...byTierPass.values()].map((bucket) => ({ ...bucket })),
    documents,
    bytes: acrossKinds(kinds, (kind) => kind.bytes),
    cacheHits: totals.cacheHits,
    cacheMisses: totals.cacheMisses,
    // A remainder, not a counter, and signed for the same reason
    // `unattributedMs` is — see the field's own doc.
    uncachedParses: documents - totals.cacheMisses,
    totalCalls: acrossKinds(kinds, (kind) => kind.total.calls),
    totalMs: acrossKinds(kinds, (kind) => kind.total.elapsedMs),
    unattributedMs: acrossKinds(kinds, (kind) => kind.unattributedMs),
    ...lifetime,
  };
}

/**
 * Which of the zero-states — or a real measurement — these numbers are.
 *
 * The order of the tests is the content. Documents first, because any document
 * that reached a parser makes the passes meaningful whatever the cache did. Then
 * the warm case, then the case where the misses went somewhere no instrumented
 * parser reported, and only then "nothing happened at all" — which is the
 * suspicious one and must not absorb the other two.
 *
 * @param merged - One repeat's merged numbers
 * @returns What the row's figures actually describe
 */
export function attributionOf(merged: MergedParseDumps): ParseAttribution {
  if (merged.documents > 0) return 'measured';
  if (merged.cacheHits > 0) return 'all-cache-hits';
  if (merged.cacheMisses > 0) return 'uninstrumented-only';
  return 'nothing-parsed';
}

/**
 * Did two repeats do the same work for one parser kind?
 *
 * @param a - One repeat's group
 * @param b - The other repeat's group for the same kind, or `undefined`
 * @returns True when the two describe the same parse work
 */
function sameKindWork(a: MergedParseKind, b: MergedParseKind | undefined): boolean {
  if (b === undefined) return false;
  if (
    a.documents !== b.documents ||
    a.bytes !== b.bytes ||
    a.total.calls !== b.total.calls ||
    a.passes.length !== b.passes.length
  ) {
    return false;
  }
  const callsByPass = new Map(b.passes.map((pass) => [pass.pass, pass.calls] as const));
  return a.passes.every((pass) => callsByPass.get(pass.pass) === pass.calls);
}

/**
 * Did two repeats do the same parse work?
 *
 * Compares only what is deterministic: each kind's documents, bytes and pass
 * call counts, plus the cache split. `elapsedMs` is excluded because it always
 * varies — a stability flag that included it would be permanently `false` and
 * would say nothing about whether the two runs parsed the same corpus. The
 * process wall and CPU readings are excluded for the same reason, and they are
 * not parse work in any case.
 *
 * Pure, so a capture can call it per repeat without touching the disk again.
 *
 * @param a - One repeat's merge
 * @param b - Another repeat's merge
 * @returns True when the two parsed the same work
 */
export function sameParseWork(a: MergedParseDumps, b: MergedParseDumps): boolean {
  if (
    a.cacheHits !== b.cacheHits ||
    a.cacheMisses !== b.cacheMisses ||
    a.kinds.length !== b.kinds.length ||
    a.tier.length !== b.tier.length
  ) {
    return false;
  }
  // Tier CALL counts are as deterministic as a pass's — the same corpus reads
  // the same entries and crosses the boundary the same number of times — so a
  // repeat that dispatched a different number of documents is a repeat that did
  // different work, even when every parser kind matches. `elapsedMs` is excluded
  // here for the same reason it is above.
  const tierCalls = new Map(b.tier.map((row) => [row.pass, row.calls] as const));
  if (!a.tier.every((row) => tierCalls.get(row.pass) === row.calls)) return false;

  const byKind = new Map(b.kinds.map((kind) => [kind.kind, kind] as const));
  return a.kinds.every((kind) => sameKindWork(kind, byKind.get(kind.kind)));
}

/**
 * Read every parse-timing dump in a directory and merge them.
 *
 * **The directory must hold exactly one command run's dumps** — a reused
 * directory cannot be told from a run that spawned more children, and would
 * inflate every duration. `withDumpDirs` is how a capture keeps that true.
 *
 * An empty directory is a refusal rather than a zero: no dump means either the
 * seam was never switched on or this vat build has none, and "parsing took no
 * time" is a plausible-looking lie a reader has no way to catch.
 *
 * @param directory - Where the seam wrote its dumps
 * @returns The merged numbers, or a refusal
 */
export async function readParseDumps(directory: string): Promise<MergedParseDumpsResult> {
  const read = await readDumpFiles(directory, PARSE_DUMP_KIND);
  if (!read.ok) return read;
  return { ok: true, merged: mergeParseDumps(read.dumps) };
}
