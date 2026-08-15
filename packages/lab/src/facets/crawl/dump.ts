/**
 * Reading the crawl-timing seam's dumps and merging them into one command's
 * numbers.
 *
 * The seam lives inside vat: when {@link CRAWL_TIMING_DIR_ENV} names a directory,
 * every vat process writes one JSON file there at exit. The file plumbing — read
 * every dump, refuse a malformed or wrong-version one, refuse an empty directory
 * rather than reporting zero — belongs to `harness/dumps.ts` and is shared with
 * `io` and `parse`. What is here is the part that is only true of crawl timings.
 *
 * ## Why the env-var name and the dump shape are declared HERE
 *
 * Not imported from `@vibe-agent-toolkit/resources`, even though that package
 * writes the file, and for the same reason `parse/dump.ts` states: **an arm of an
 * A/B may be a vat build that has no seam at all**. A lab that imported the
 * contract from the package under measurement could not be built against a
 * version that predates it, and this facet has to be able to point at either arm
 * and refuse cleanly rather than fail to compile. `test/crawl-dump.test.ts` pins
 * the literal.
 *
 * ## An empty `entries` array is a reading; an empty DIRECTORY is not
 *
 * These are different facts and the distinction is the whole reason vat's seam
 * files a dump even when it charged nothing. No file at all means the instrument
 * was never switched on, or this build has no seam — "crawling was free" is a
 * plausible-looking lie a reader cannot catch, so that is a refusal. A file with
 * no rows means the seam ran and the command never reached a crawler, which is a
 * real and often surprising finding about the command. It is published as
 * `nothing-crawled` rather than folded into a zero.
 *
 * ## What merging across processes means
 *
 * A vat command spawns a child per phase, so several dumps per run is the normal
 * case. Calls and durations are summed, which makes `elapsedMs` **time spent in
 * that row across the run** and emphatically not wall time: if two phases ran
 * concurrently their milliseconds still add.
 *
 * Process LIFETIMES are the one thing that is never summed — see
 * {@link MergedCrawlDumps.processes}.
 */

import { z } from 'zod';

import { type DumpKind, type DumpsRefusal, readDumpFiles } from '../../harness/dumps.js';

import type { CrawlAttribution, CrawlEntryStats, CrawlStratumStats } from './types.js';
import { crawlEntryShape, crawlProcessShape } from './types.js';

/**
 * The variable that switches the seam on, and whose VALUE is the directory the
 * dumps are written to.
 *
 * A literal, deliberately not imported — see this module's header.
 */
export const CRAWL_TIMING_DIR_ENV = 'VAT_CRAWL_TIMING';

/**
 * Version of the dump format written by the seam.
 *
 * A fixed contract between the seam and this reader. A dump at any other version
 * is refused, because reading it with this build's assumptions would produce
 * numbers whose meaning nobody can state.
 *
 * 1 — first version.
 */
export const CRAWL_DUMP_VERSION = 1;

/** One row as the seam wrote it. */
export type CrawlDumpEntry = CrawlEntryStats;

/**
 * One process's wall and CPU time, as the seam read it at exit.
 *
 * Lifetime figures for the whole process, **not** for the crawl.
 */
export interface CrawlDumpProcess {
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
}

/** One process's dump. */
export interface CrawlDump {
  readonly dumpVersion: number;
  readonly pid: number;
  readonly process: CrawlDumpProcess;
  readonly entries: readonly CrawlDumpEntry[];
}

/** What a dump naming one `(contributorId, stratum, pass)` twice is rejected with. */
const DUPLICATE_ENTRY_MESSAGE =
  'a dump must name each (contributorId, stratum, pass) once; two rows for one key would be ' +
  'summed into a number whose meaning depends on which row the seam wrote first';

/**
 * The key a row is unique under.
 *
 * The id goes last so no escaping is needed: a stratum and a pass cannot contain
 * the separator, and a contributor id may then contain anything.
 *
 * @param entry - One row
 * @returns Its identity within a dump
 */
export function crawlEntryKey(entry: {
  readonly contributorId: string;
  readonly stratum: string;
  readonly pass: number;
}): string {
  return `${entry.stratum}|${String(entry.pass)}|${entry.contributorId}`;
}

/**
 * Is each row named once?
 *
 * @param dump - The dump being validated
 * @returns True when every row's key is distinct
 */
function entryKeysAreUnique(dump: { readonly entries: readonly CrawlDumpEntry[] }): boolean {
  return new Set(dump.entries.map((entry) => crawlEntryKey(entry))).size === dump.entries.length;
}

/**
 * Runtime schema for {@link CrawlDump}. Strict: the seam is ours, so an unknown
 * field is a bug.
 *
 * `entries` has no minimum length, deliberately — see this module's header on why
 * an empty array is a reading and an empty directory is not.
 */
export const CrawlDumpSchema = z
  .object({
    dumpVersion: z.number().int().positive(),
    pid: crawlProcessShape.pid,
    process: z
      .object({
        wallMs: crawlProcessShape.wallMs,
        cpuUserMs: crawlProcessShape.cpuUserMs,
        cpuSystemMs: crawlProcessShape.cpuSystemMs,
      })
      .strict(),
    entries: z.array(z.object(crawlEntryShape).strict()),
  })
  .strict()
  .refine(entryKeysAreUnique, { message: DUPLICATE_ENTRY_MESSAGE });

/** One process's lifetime, carried through the merge intact. */
export interface CrawlProcessRecord extends CrawlDumpProcess {
  readonly pid: number;
}

/** Every dump from one command run, merged. */
export interface MergedCrawlDumps {
  /**
   * One entry per DUMP — never per distinct pid, and never reduced to a total.
   *
   * Per dump because pids are reused across a long multi-phase run (vat's seam
   * carries a collision counter in the filename precisely for that), so counting
   * distinct pids reports two real processes as one — the defect `parse`'s
   * `processes` field carries today.
   *
   * Never totalled because there is no honest total: the parent orchestrator is
   * alive for the whole run, so its lifetime CONTAINS every child's and a sum
   * double-counts real time. `parse` sums it and its trust ratio is
   * systematically deflated as a result. Nothing in a dump says which pid is the
   * parent, so rather than pick a wrong denominator this publishes all of them.
   */
  readonly processes: readonly CrawlProcessRecord[];
  /** Every row, summed across processes, in the order the seam first emitted them. */
  readonly entries: readonly CrawlEntryStats[];
  /** Per-stratum rollups, in first-appearance order. */
  readonly strata: readonly CrawlStratumStats[];
  /** Invocations charged anywhere. */
  readonly totalCalls: number;
  /** Time inside a crawler, across every stratum. */
  readonly totalMs: number;
}

/** A merge that succeeded. */
export interface CrawlDumpsAccepted {
  readonly ok: true;
  readonly merged: MergedCrawlDumps;
}

/** The outcome of reading a directory of crawl-timing dumps. */
export type MergedCrawlDumpsResult = CrawlDumpsAccepted | DumpsRefusal;

/** Mutable accumulator behind one merged row. */
interface EntryBucket {
  readonly contributorId: string;
  readonly stratum: string;
  readonly pass: number;
  calls: number;
  elapsedMs: number;
}

/**
 * What the shared dump reader needs to know about a crawl-timing dump.
 *
 * The empty-directory sentence is this facet's own because the *lie* it prevents
 * is specific: here it would read as "finding the documents was free", and the
 * far likelier cause is a vat build with no crawl seam in it at all.
 */
const CRAWL_DUMP_KIND: DumpKind<CrawlDump> = {
  noun: 'crawl-timing dump',
  producer: 'crawl-timing seam',
  schema: CrawlDumpSchema,
  version: CRAWL_DUMP_VERSION,
  versionOf: (dump) => dump.dumpVersion,
  emptyDirectory: (directory) =>
    `no crawl-timing dumps in '${directory}'. Nothing wrote one, so there is no measurement — ` +
    `the usual cause is a vat build with no crawl seam in it (it is switched on by ` +
    `${CRAWL_TIMING_DIR_ENV}, and a build that predates the seam ignores it). Note that a build ` +
    'WITH the seam writes a dump even when it crawled nothing, so an empty directory never means ' +
    'an idle command. Reporting zero milliseconds here would say finding the documents was free.',
};

/**
 * Add one process's rows into the running buckets.
 *
 * @param byKey - Every row's bucket, mutated in place
 * @param dump - One process's dump
 */
function addDumpEntries(byKey: Map<string, EntryBucket>, dump: CrawlDump): void {
  for (const entry of dump.entries) {
    const key = crawlEntryKey(entry);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, {
        contributorId: entry.contributorId,
        stratum: entry.stratum,
        pass: entry.pass,
        calls: entry.calls,
        elapsedMs: entry.elapsedMs,
      });
      continue;
    }
    bucket.calls += entry.calls;
    bucket.elapsedMs += entry.elapsedMs;
  }
}

/**
 * Roll the merged rows up per stratum.
 *
 * First-appearance order rather than by cost, so two reports of one run list
 * their rows identically and can be read side by side.
 *
 * @param entries - The merged rows
 * @returns One rollup per stratum
 */
function rollUpStrata(entries: readonly CrawlEntryStats[]): readonly CrawlStratumStats[] {
  const byStratum = new Map<string, { stratum: string; calls: number; elapsedMs: number }>();
  for (const entry of entries) {
    const bucket = byStratum.get(entry.stratum);
    if (bucket === undefined) {
      byStratum.set(entry.stratum, {
        stratum: entry.stratum,
        calls: entry.calls,
        elapsedMs: entry.elapsedMs,
      });
      continue;
    }
    bucket.calls += entry.calls;
    bucket.elapsedMs += entry.elapsedMs;
  }
  return [...byStratum.values()];
}

/**
 * Merge every process's dump from one command run.
 *
 * @param dumps - Every dump the run produced
 * @returns The merged numbers
 */
export function mergeCrawlDumps(dumps: readonly CrawlDump[]): MergedCrawlDumps {
  const byKey = new Map<string, EntryBucket>();
  const processes: CrawlProcessRecord[] = [];

  for (const dump of dumps) {
    processes.push({ pid: dump.pid, ...dump.process });
    addDumpEntries(byKey, dump);
  }

  const entries = [...byKey.values()].map((bucket) => ({ ...bucket }));
  return {
    processes,
    entries,
    strata: rollUpStrata(entries),
    totalCalls: entries.reduce((sum, entry) => sum + entry.calls, 0),
    totalMs: entries.reduce((sum, entry) => sum + entry.elapsedMs, 0),
  };
}

/**
 * Which of the states — or a real measurement — these numbers are.
 *
 * @param merged - One repeat's merged numbers
 * @returns What the row's figures actually describe
 */
export function crawlAttributionOf(merged: MergedCrawlDumps): CrawlAttribution {
  return merged.entries.length > 0 ? 'measured' : 'nothing-crawled';
}

/**
 * Did two repeats do the same crawl work?
 *
 * Compares only what is deterministic: the row set and each row's call count.
 * `elapsedMs` is excluded because it always varies, and a flag that included it
 * would be permanently `false` and would say nothing about whether the two runs
 * crawled the same corpus. The process lifetimes are excluded for the same
 * reason, and they are not crawl work in any case.
 *
 * Pure, so a capture can call it per repeat without touching the disk again.
 *
 * @param a - One repeat's merge
 * @param b - Another repeat's merge
 * @returns True when the two crawled the same work
 */
export function sameCrawlWork(a: MergedCrawlDumps, b: MergedCrawlDumps): boolean {
  if (a.entries.length !== b.entries.length) return false;
  const callsByKey = new Map(
    b.entries.map((entry) => [crawlEntryKey(entry), entry.calls] as const),
  );
  return a.entries.every((entry) => callsByKey.get(crawlEntryKey(entry)) === entry.calls);
}

/**
 * Read every crawl-timing dump in a directory and merge them.
 *
 * **The directory must hold exactly one command run's dumps** — a reused
 * directory cannot be told from a run that spawned more children, and would
 * inflate every duration. `withDumpDirs` is how a capture keeps that true.
 *
 * @param directory - Where the seam wrote its dumps
 * @returns The merged numbers, or a refusal
 */
export async function readCrawlDumps(directory: string): Promise<MergedCrawlDumpsResult> {
  const read = await readDumpFiles(directory, CRAWL_DUMP_KIND);
  if (!read.ok) return read;
  return { ok: true, merged: mergeCrawlDumps(read.dumps) };
}
