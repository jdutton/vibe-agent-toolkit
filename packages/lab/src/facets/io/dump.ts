/**
 * Reading the counter's dumps and merging them into one command's numbers.
 *
 * The counter is injected into the measured process and writes one JSON file
 * per process. Three things here are not incidental:
 *
 * 1. **Every dump in the directory is read, not the first one.** The counter
 *    propagates into descendant processes, and a single `vat` invocation
 *    produces two dumps because vat's launcher spawns a second node process for
 *    the real binary. A reader that took one file would report the launcher's
 *    handful of calls and look entirely healthy doing it — the most expensive
 *    shape of wrong answer this module can give, because nothing in the output
 *    says it is partial.
 * 2. **Sites are normalized before they are merged.** Two processes can reach
 *    one module by different real paths (bun nests them under
 *    `node_modules/.bun/<pkg>@<version>/node_modules/<pkg>/…`), and unnormalized
 *    keys split one hot site into two lukewarm ones — hiding exactly the
 *    repetition the facet exists to find. Normalization is also what makes a
 *    report from one machine comparable to a report from another.
 * 3. **A malformed dump is refused, never coerced.** A counter that wrote
 *    something this build does not model has measured something this build
 *    cannot read, and "zero I/O" is a perfectly plausible-looking lie. The
 *    house rule for the whole lab: refuse rather than coerce.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { type DumpKind, type DumpsRefusal, readDumpFiles } from '../../harness/dumps.js';

import { CAPPED_WITHOUT_READING_MESSAGE, cappedNeedsAReading, ioSiteShape } from './types.js';
import type { IoSite } from './types.js';

/**
 * Version of the dump format written by the counter.
 *
 * A fixed contract between the injected counter and this reader. Bumped when
 * the row shape changes; a dump at any other version is refused, because
 * reading it with this build's assumptions would produce numbers whose meaning
 * nobody can state. `2` since `distinctArgs` became nullable: a version-1 dump
 * writes `1` for a spawn site where this build writes `null`, and those two say
 * opposite things about the same row.
 */
export const IO_DUMP_VERSION = 2;

/** The `node_modules` boundary, matched on its LAST occurrence. See {@link normalizeSite}. */
const NODE_MODULES_SEGMENT = '/node_modules/';

/**
 * Marker for a site inside the measured project rather than inside vat.
 *
 * A literal token, not the project's path: the path differs on every machine,
 * and the *fact* that the call came from the subject is what a reader needs.
 */
const SUBJECT_PREFIX = '<subject>/';

/**
 * Build the key a bucket is merged under.
 *
 * Length-prefixed rather than delimiter-joined: a method name is arbitrary and
 * a path may contain any character a filesystem allows, so any printable
 * separator could be produced by the data itself and silently merge two
 * different buckets into one. Prefixing the method with its length makes the
 * split unambiguous whatever the parts contain.
 *
 * @param cls - Which class of code made the calls
 * @param method - The Node API called
 * @param site - The already-normalized call site
 * @returns A key that is equal for two rows exactly when all three parts are
 */
function bucketKey(cls: IoClass, method: string, site: string): string {
  return `${cls}:${String(method.length)}:${method}:${site}`;
}

/** Which class of code made a call. */
export type IoClass = 'user' | 'loader';

/** One row as the counter wrote it. */
export interface IoDumpRow {
  /**
   * `loader` for Node's own ESM module loader, `user` for everything else.
   *
   * The split is what makes the report readable: on `vat resources scan docs/`,
   * 6,371 of 6,411 calls were the loader. Without the class, vat's own 40 calls
   * are a rounding error in a list of Node internals.
   */
  readonly cls: IoClass;
  /** The Node API called — `fs.readFile`, `child_process.spawnSync`. Not a syscall name. */
  readonly method: string;
  /** Absolute call site with a line number, or `''` for a loader row. */
  readonly site: string;
  readonly count: number;
  /**
   * Distinct first arguments seen at this site in this process, or `null` when
   * the counter took no reading — a loader row, or a method whose first argument
   * does not identify the work. See {@link IoSite.distinctArgs}.
   */
  readonly distinctArgs: number | null;
  /** True when the counter stopped tracking new arguments at this site. */
  readonly argsCapped: boolean;
}

/** One process's dump. */
export interface IoDump {
  readonly dumpVersion: number;
  readonly pid: number;
  readonly rows: readonly IoDumpRow[];
}

const IoDumpRowSchema = z
  .object({
    cls: z.union([z.literal('user'), z.literal('loader')]),
    ...ioSiteShape,
  })
  .strict()
  // Part of the contract, not a nicety: loader calls are bucketed in aggregate
  // and have no site to report. A loader row carrying a path would put an
  // absolute, machine-specific string into a field this reader never
  // normalizes, and it would do it silently.
  .refine((row) => row.cls !== 'loader' || row.site === '', {
    message: "a 'loader' row must carry an empty site — loader calls are bucketed, not located",
  })
  // The other half of the same contract: no distinct-argument set is kept for
  // loader calls, so a number there would report a measurement never taken.
  .refine((row) => row.cls !== 'loader' || row.distinctArgs === null, {
    message:
      "a 'loader' row must carry no distinct-argument reading — loader calls are counted, not identified",
  })
  .refine(cappedNeedsAReading, { message: CAPPED_WITHOUT_READING_MESSAGE });

/** Runtime schema for {@link IoDump}. Strict: the counter is ours, so an unknown field is a bug. */
export const IoDumpSchema = z
  .object({
    dumpVersion: z.number().int().positive(),
    pid: z.number().int().nonnegative(),
    rows: z.array(IoDumpRowSchema),
  })
  .strict();

/** The two roots a site is expressed relative to. Both must be absolute. */
export interface SiteRoots {
  /** The vat checkout or dist being measured with — axis C's filesystem home. */
  readonly instrumentRoot: string;
  /** The project being measured — axis A's filesystem home. */
  readonly subjectPath: string;
}

/** Every dump in one directory, merged. */
export interface MergedDumps {
  /**
   * Distinct PIDs that produced a dump.
   *
   * Reported rather than assumed: a real `vat` invocation should never yield 1,
   * because the launcher spawns a second node process for the binary. When it
   * does, the counter failed to propagate and these numbers describe the
   * launcher alone.
   */
  readonly processes: number;
  /** Total loader-class calls, kept in aggregate and never dropped. */
  readonly loaderCalls: number;
  /** Total user-class calls — the sum over {@link MergedDumps.sites}. */
  readonly userCalls: number;
  /** User-class sites, descending by count, ties broken deterministically. */
  readonly sites: readonly IoSite[];
  /**
   * `(cls, method, site) -> count`, the multiset {@link sameBuckets} compares.
   *
   * Exposed rather than recomputed by callers because the loader rows are in it
   * and {@link MergedDumps.sites} deliberately is not: a stability check built
   * from `sites` alone would call two repeats identical while the loader moved
   * underneath them.
   */
  readonly buckets: ReadonlyMap<string, number>;
}

/** A merge that succeeded. */
export interface DumpsAccepted {
  readonly ok: true;
  readonly merged: MergedDumps;
}

/** The outcome of reading a directory of dumps. */
export type MergedDumpsResult = DumpsAccepted | DumpsRefusal;

/** Mutable accumulator behind one merged bucket. */
interface Bucket {
  readonly cls: IoClass;
  readonly method: string;
  readonly site: string;
  count: number;
  distinctArgs: number | null;
  argsCapped: boolean;
}

/**
 * Render a path for prefix comparison only.
 *
 * Forward slashes, and an upper-cased drive letter: Windows hands back either
 * case for one drive, so a case-sensitive comparison would decide the
 * instrument's own files were foreign and leave every site absolute and
 * machine-specific. The rest of the path keeps its case, because on POSIX
 * `/Repo` and `/repo` really are different directories.
 *
 * @param value - A path
 * @returns The same path, comparable — and the same length, so an offset into
 *   it is also an offset into the original
 */
function comparablePath(value: string): string {
  const forward = toForwardSlash(value);
  return /^[a-z]:/.test(forward) ? forward.charAt(0).toUpperCase() + forward.slice(1) : forward;
}

/**
 * Drop trailing slashes from a root.
 *
 * Hand-rolled rather than a `/\\/+$/` replace: a greedy repeat anchored at the
 * end backtracks, and this string comes from a caller-supplied root.
 *
 * @param value - A path
 * @returns The same path with any trailing separators removed
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

/**
 * Strip a root prefix, or say the path is not under it.
 *
 * Requires the separator after the root, so `/repo/vat-other` is not read as
 * living under `/repo/vat`.
 *
 * @param forwardSite - The site, already forward-slashed
 * @param root - The root to strip
 * @returns The remainder, or `null` when the site is not under `root`
 */
function stripRoot(forwardSite: string, root: string): string | null {
  const comparableRoot = withoutTrailingSlashes(comparablePath(root));
  if (comparableRoot === '') return null;
  const prefix = `${comparableRoot}/`;
  if (!comparablePath(forwardSite).startsWith(prefix)) return null;
  return forwardSite.slice(prefix.length);
}

/**
 * Rewrite an absolute call site into a machine-independent one.
 *
 * The rules, in order:
 *
 * 1. **Anything containing `node_modules` keeps only its LAST `node_modules/`
 *    onward.** Bun installs real files at
 *    `…/node_modules/.bun/isexe@3.1.4/node_modules/isexe/dist/index.js`; keying
 *    on the first occurrence would bake the version and the package manager's
 *    layout into the site, so the same dependency read from a pnpm or npm tree
 *    would look like a different one.
 * 2. **Under the instrument root → root-relative**, which is the readable form:
 *    `packages/resources/dist/content-key.js:141`.
 * 3. **Under the subject path → prefixed {@link SUBJECT_PREFIX}**, so a call
 *    made from the measured project is visibly not vat's own code. Checked
 *    after the instrument root, so that when a subject sits inside a vat
 *    checkout the site is named in the instrument's terms — a site is a
 *    *caller*, and callers are overwhelmingly vat's own code.
 * 4. Otherwise left alone. A site outside all three is genuinely foreign (a
 *    global node install, a temp dir, a `node:` internal), and inventing a
 *    relative form for it would claim a relationship that does not exist.
 *
 * Always returns forward slashes.
 *
 * @param site - Raw site from a dump, with its `:line` suffix
 * @param roots - See {@link SiteRoots}
 * @returns The normalized site
 */
export function normalizeSite(site: string, roots: SiteRoots): string {
  const forward = toForwardSlash(site);

  const lastNodeModules = forward.lastIndexOf(NODE_MODULES_SEGMENT);
  if (lastNodeModules !== -1) return forward.slice(lastNodeModules + 1);

  const fromInstrument = stripRoot(forward, roots.instrumentRoot);
  if (fromInstrument !== null) return fromInstrument;

  const fromSubject = stripRoot(forward, roots.subjectPath);
  if (fromSubject !== null) return `${SUBJECT_PREFIX}${fromSubject}`;

  return forward;
}

/**
 * Fold one row into the accumulator.
 *
 * @param byKey - Accumulator, keyed by class, method and normalized site
 * @param row - The row to add
 * @param site - The row's already-normalized site
 */
function accumulate(byKey: Map<string, Bucket>, row: IoDumpRow, site: string): void {
  const key = bucketKey(row.cls, row.method, site);
  const existing = byKey.get(key);
  if (existing === undefined) {
    byKey.set(key, {
      cls: row.cls,
      method: row.method,
      site,
      count: row.count,
      distinctArgs: row.distinctArgs,
      argsCapped: row.argsCapped,
    });
    return;
  }
  existing.count += row.count;
  // Summed, which makes it an upper bound across processes — two processes
  // reading one file each count it. Documented on `IoSite.distinctArgs`; that
  // direction of error can only make repeated work look more necessary than it
  // was, never less, so the N+1 detector never fires on it falsely.
  //
  // Summing is defined over READINGS only. A missing one stays missing rather
  // than contributing a zero: `null + 3` is not 3, it is "one of these processes
  // never looked", and a total built on that would read as a measurement.
  existing.distinctArgs =
    existing.distinctArgs === null || row.distinctArgs === null
      ? null
      : existing.distinctArgs + row.distinctArgs;
  existing.argsCapped ||= row.argsCapped;
}

/**
 * Order sites for the report.
 *
 * Descending by count, then by method and site so two identical measurements
 * serialise identically. Without the tie-break the order would follow whatever
 * sequence the directory happened to be read in, and a report would differ from
 * itself.
 *
 * @param a - One site
 * @param b - Another
 * @returns Standard comparator result
 */
function compareSites(a: IoSite, b: IoSite): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.method !== b.method) return a.method < b.method ? -1 : 1;
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return 0;
}

/**
 * Merge every process's dump from one command run.
 *
 * @param dumps - Every dump the run produced
 * @param roots - See {@link SiteRoots}
 * @returns The merged numbers
 */
export function mergeDumps(dumps: readonly IoDump[], roots: SiteRoots): MergedDumps {
  const byKey = new Map<string, Bucket>();
  const pids = new Set<number>();

  for (const dump of dumps) {
    pids.add(dump.pid);
    for (const row of dump.rows) {
      accumulate(byKey, row, row.cls === 'loader' ? '' : normalizeSite(row.site, roots));
    }
  }

  const buckets = new Map<string, number>();
  const sites: IoSite[] = [];
  let loaderCalls = 0;
  let userCalls = 0;

  for (const [key, bucket] of byKey) {
    buckets.set(key, bucket.count);
    if (bucket.cls === 'loader') {
      loaderCalls += bucket.count;
      continue;
    }
    userCalls += bucket.count;
    sites.push({
      method: bucket.method,
      site: bucket.site,
      count: bucket.count,
      distinctArgs: bucket.distinctArgs,
      argsCapped: bucket.argsCapped,
    });
  }

  sites.sort(compareSites);
  return { processes: pids.size, loaderCalls, userCalls, sites, buckets };
}

/**
 * What the shared dump reader needs to know about an `io` dump.
 *
 * Everything here is this facet's own: how one dump is spelled, what wrote it,
 * and what an empty directory would be lying about. The plumbing around it —
 * read every file, refuse a malformed or wrong-version one, refuse an empty
 * directory — lives in `harness/dumps.ts`, because the `parse` facet needs the
 * identical guarantees over a completely different payload.
 */
const IO_DUMP_KIND: DumpKind<IoDump> = {
  noun: 'I/O dump',
  producer: 'counter',
  schema: IoDumpSchema,
  version: IO_DUMP_VERSION,
  versionOf: (dump) => dump.dumpVersion,
  emptyDirectory: (directory) =>
    `no I/O dumps in '${directory}'. The counter never wrote one, so there is no measurement — ` +
    'reporting zero calls here would say vat touched nothing.',
};

/**
 * Read every dump in a directory and merge them.
 *
 * **The directory must hold exactly one command run's dumps.** Nothing here can
 * tell a leftover dump from an earlier repeat apart from a descendant process of
 * this one — both are just files with distinct PIDs — so a directory reused
 * across repeats silently inflates every count. A fresh directory per repeat is
 * the capture's responsibility.
 *
 * An empty directory is a refusal rather than a zero: no dumps means the counter
 * never ran, and "vat made no filesystem calls" is a plausible-looking lie a
 * reader has no way to catch.
 *
 * @param directory - Where the counter wrote its dumps
 * @param roots - See {@link SiteRoots}
 * @returns The merged numbers, or a refusal
 */
export async function readDumps(directory: string, roots: SiteRoots): Promise<MergedDumpsResult> {
  const read = await readDumpFiles(directory, IO_DUMP_KIND);
  if (!read.ok) return read;
  return { ok: true, merged: mergeDumps(read.dumps, roots) };
}

/**
 * Did two repeats do the same I/O?
 *
 * Compares the `(cls, method, site) -> count` multisets, which is stricter than
 * comparing totals on purpose: two repeats can make the same number of calls in
 * a different shape, and calling those identical would let a real change hide
 * inside a stable-looking number. Loader movement counts too — the loader
 * buckets are in the map even though they are absent from `sites`.
 *
 * `distinctArgs` and `argsCapped` are deliberately not compared: they describe a
 * site rather than the calls, and a capped site can report a different bound run
 * to run without the work having changed.
 *
 * Pure, so a capture can call it per repeat without touching the disk again.
 *
 * @param a - One repeat's merge
 * @param b - Another repeat's merge
 * @returns True when the two made exactly the same calls
 */
export function sameBuckets(a: MergedDumps, b: MergedDumps): boolean {
  if (a.buckets.size !== b.buckets.size) return false;
  for (const [key, count] of a.buckets) {
    if (b.buckets.get(key) !== count) return false;
  }
  return true;
}
