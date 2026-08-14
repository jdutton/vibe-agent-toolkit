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
 * ## What merging across processes means
 *
 * A vat command spawns a child per phase, so several dumps per run is the normal
 * case rather than a warning sign. Counts and durations are summed, which makes
 * `elapsedMs` **time spent in that pass across the run** and emphatically not
 * wall time: if two phases ran concurrently their milliseconds still add. The
 * value of the number is its share of its group's total, which is summed the
 * same way and therefore stays a valid denominator.
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
 * Version of the dump format written by the seam.
 *
 * A fixed contract between the seam and this reader. Bumped when the row shape
 * changes; a dump at any other version is refused, because reading it with this
 * build's assumptions would produce numbers whose meaning nobody can state.
 *
 * 2 — passes and documents grouped per parser kind, each group carrying its own
 * total, plus process wall/CPU time.
 */
export const PARSE_DUMP_VERSION = 2;

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

/** One process's dump. */
export interface ParseDump {
  readonly dumpVersion: number;
  readonly pid: number;
  readonly process: ParseDumpProcess;
  /** Parse-cache outcomes across every parser kind. */
  readonly cache: { readonly hits: number; readonly misses: number };
  readonly kinds: readonly ParseDumpKind[];
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

/** Runtime schema for {@link ParseDump}. Strict: the seam is ours, so an unknown field is a bug. */
export const ParseDumpSchema = z
  .object({
    dumpVersion: z.number().int().positive(),
    pid: z.number().int().nonnegative(),
    process: z
      .object({ wallMs: durationMs, cpuUserMs: durationMs, cpuSystemMs: durationMs })
      .strict(),
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
  })
  .strict()
  .refine(totalsNameTheirKind, { message: MISLABELLED_TOTAL_MESSAGE })
  .refine(passNamesAreUnique, { message: DUPLICATE_PASS_MESSAGE })
  .refine(kindNamesAreUnique, { message: DUPLICATE_KIND_MESSAGE });

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

/** Every dump from one command run, merged. */
export interface MergedParseDumps {
  /**
   * Distinct PIDs that produced a dump. See this module's header on summing.
   *
   * ⚠️ REVIEW FINDING 2026-08-14 — this UNDER-COUNTS in exactly the case the
   * writer was built for. `parse-timing.ts`'s `nextDumpPath` carries a collision
   * counter precisely because "pids are reused across a long multi-phase run",
   * and `parse-timing.test.ts` pins that one pid can file two dumps. Counting
   * `pids.size` then reports those two as ONE process. The durations and counts
   * still merge correctly; only this field lies. Counting dumps rather than pids
   * is the obvious fix, but it changes a published field, so: Jeff's call.
   */
  readonly processes: number;
  /** One entry per parser kind the dumps carried, in first-appearance order. */
  readonly kinds: readonly MergedParseKind[];
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
  /** Process lifetime wall clock, summed across processes. Not a parse duration. */
  readonly wallMs: number;
  /** User CPU, summed across processes. */
  readonly cpuUserMs: number;
  /** System CPU, summed across processes. */
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

/** Mutable accumulator behind one merged parser kind. */
interface KindBucket {
  readonly kind: string;
  documents: number;
  bytes: number;
  readonly total: PassBucket;
  readonly passes: Map<string, PassBucket>;
}

/**
 * Every process-level scalar a merge sums, in one bag.
 *
 * The per-kind numbers are not here — they belong to their group. What is left
 * is what the process, rather than a parser, reports.
 */
interface DumpTotals {
  cacheHits: number;
  cacheMisses: number;
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
  version: PARSE_DUMP_VERSION,
  versionOf: (dump) => dump.dumpVersion,
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
 * Add one process's non-parser scalars to the running totals.
 *
 * Durations are summed exactly as counts are — see this module's header.
 *
 * ⚠️ REVIEW FINDING 2026-08-14 — `wallMs` SUMMING IS WRONG, and the consumer of
 * the sum is a trust signal. The justification that "wall clock adds because a
 * vat command spawns its phases one after another" holds for *parse*
 * milliseconds (disjoint work) but NOT for process *lifetimes*: the parent
 * orchestrator is alive for the whole run, so its lifetime CONTAINS every
 * child's, and summing double-counts real time. CPU genuinely does add (disjoint
 * threads), so the ratio `cpu / wallMs` that `render.ts` divides — against
 * `CPU_BOUND_FLOOR = 0.7` — is systematically DEFLATED, and the deflation grows
 * without bound in the number of phases.
 *
 * Measured on `vat validate` (VAT's own repo, 2 processes): parent wall 3064ms
 * with ZERO documents, child wall 2207ms, CPU 3822ms.
 *   reported 3822/5272 = 0.725   ·   true 3822/3064 = 1.247
 * A compute-bound run therefore sits 3.6% above a banner reading "THE PROCESS
 * SPENT MOST OF ITS LIFE NOT RUNNING"; ~189ms more of child wall trips it.
 *
 * NOT fixed here because the right denominator is a design call: `max` is right
 * only for a strictly-nested tree, parent-only needs a parent pid the dump does
 * not carry, and per-process ratios trade one number for N. `resources-validate`
 * is single-process, so no figure currently in the record is affected — this
 * bites `validate`/`verify`. `parse-dump.test.ts`'s two-process fixture gives
 * both processes equal, non-nested lifetimes, so it cannot tell sum from max.
 *
 * @param totals - The bag being accumulated into, mutated in place
 * @param dump - One process's dump
 */
function addDumpTotals(totals: DumpTotals, dump: ParseDump): void {
  totals.cacheHits += dump.cache.hits;
  totals.cacheMisses += dump.cache.misses;
  totals.wallMs += dump.process.wallMs;
  totals.cpuUserMs += dump.process.cpuUserMs;
  totals.cpuSystemMs += dump.process.cpuSystemMs;
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
  const pids = new Set<number>();
  const byKind = new Map<string, KindBucket>();
  const totals: DumpTotals = {
    cacheHits: 0,
    cacheMisses: 0,
    wallMs: 0,
    cpuUserMs: 0,
    cpuSystemMs: 0,
  };

  for (const dump of dumps) {
    pids.add(dump.pid);
    addDumpTotals(totals, dump);
    for (const group of dump.kinds) addKindGroup(byKind, group);
  }

  const kinds = [...byKind.values()].map((bucket) => closeKind(bucket));
  const documents = acrossKinds(kinds, (kind) => kind.documents);

  return {
    processes: pids.size,
    kinds,
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
    wallMs: totals.wallMs,
    cpuUserMs: totals.cpuUserMs,
    cpuSystemMs: totals.cpuSystemMs,
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
    a.kinds.length !== b.kinds.length
  ) {
    return false;
  }
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
