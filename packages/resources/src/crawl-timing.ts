/**
 * Timing accumulators for the work that *finds* documents, as opposed to the
 * work that parses them.
 *
 * `parse-timing.ts` attributes time inside a parser. Its instrumentation points
 * are exhaustively three files, and everything above them — the link walk, the
 * gitignore oracle, the exclude cascade, the closure's reference resolution and
 * its fixpoint iteration — is unattributed. That is not a gap in a report; it is
 * the reason VAT cannot presently answer the one question that matters before
 * either crawler is flipped onto a verb: **which of the two costs more to do its
 * own work?**
 *
 * ## Why this is a keyed map and `parse-timing.ts` is a slot array
 *
 * The parse seam's axis is a CLOSED enum — a parser kind has the passes it has,
 * they are declared in one array, and a `Float64Array` indexed by a compile-time
 * constant is exactly right for a path taken 1,364+ times per command.
 *
 * This axis is not closed. `contributorId` is dynamic: a corpus declares its own
 * extents, so on VAT's own tree there are 61 closure contributors whose ids come
 * out of config, and the fixpoint `pass` is discovered at run time. A fixed-width
 * slot array cannot carry either, and the honest answer is the one
 * {@link ContributorTiming} already models — a keyed accumulator over
 * `(contributorId, stratum, pass)`.
 *
 * The cost of the map is affordable *because* this path is cold relative to the
 * parse path: one record per contributor invocation (66 contributors × 2 passes
 * on VAT's own tree) plus one per walk and one per gitignore oracle read, against
 * ~12,000 parser-pass records. The one genuinely hot site — the closure's
 * per-reference resolution — is charged into a single pre-resolved key.
 *
 * ## What a `stratum` is here, and why the walker gets a third one
 *
 * Two of the three come straight from the merge driver: `base` contributors run
 * once, `closure` contributors iterate to a fixed point. `walkLinkGraph` is
 * neither — it is not a projection contributor at all and the driver never sees
 * it — so it records under `crawl` with a **synthetic contributor id**
 * ({@link CRAWL_WALKER_ID}, {@link CRAWL_WALKER_GITIGNORE_ID}). That is stated
 * here, and named in constants, rather than left to whatever string a call site
 * happened to pass: a synthetic id that arrives by accident is indistinguishable
 * in the dump from a real contributor, and the whole point of the dump is that
 * the two crawlers are legible side by side.
 *
 * ## `pass` 0 means "recorded from inside the work"
 *
 * The merge driver is the ONLY participant that knows which fixpoint pass is
 * running; a contributor's own `contribute` does not, and neither does a link
 * walk. So a bracket placed inside the measured code records
 * {@link CRAWL_PASS_INSIDE} — a reserved 0 — and aggregates across every pass.
 * A driver-placed record always carries a real pass number at or above 1. The
 * two are therefore never silently summed into one row: they key differently,
 * and a reader can tell a per-pass figure from an all-passes one by looking.
 *
 * ## Commensurability is the whole point, so both arms use one clock
 *
 * Every bracket in this seam — driver, closure, walker — is `performance.now()`,
 * for the same reason `parse-timing.ts` uses it: it is a float and allocates
 * nothing, where `process.hrtime.bigint()` allocates a BigInt per call. The merge
 * driver's `ContributorTiming.elapsedMs` moved to the same clock when this seam
 * landed; it was `Date.now()`, whose ~1ms granularity would have made a
 * driver-level figure and a walker-level figure incomparable at exactly the
 * resolution the comparison needs.
 *
 * ## What this dump deliberately does NOT do
 *
 * It carries the process's own wall and CPU lifetime, like the parse dump, and
 * for the same reason: these brackets are wall-timed, so a reader has to be able
 * to see that the process spent its life waiting. It does **not** invite that
 * figure to be summed across processes. `parse-timing.ts`'s review finding of
 * 2026-08-14 records that the lab sums `process.wallMs` across dumps, which
 * double-counts real time under a multi-process verb because the parent
 * orchestrator's lifetime contains every child's. The reader for THIS dump
 * publishes one lifetime per process and never a total — see
 * `packages/lab/src/facets/crawl/dump.ts`.
 *
 * ## Why the gate is read at module load
 *
 * Same reconciliation `parse-timing.ts` states: `process.env` access in Node is a
 * native call, the gate sits on paths taken thousands of times per command, and
 * the testability the per-construction rule protects is preserved by
 * {@link __setCrawlTimingForTest} rather than by re-reading the environment.
 * (`vitest.setup.js` deletes every `VAT_*` variable before any test module loads,
 * so a test could not usefully set it anyway.)
 *
 * The env var's VALUE is the directory the dump is written to; its presence is
 * what enables the seam. An empty-string value counts as absent.
 */

import {
  ensureTimingDirectory,
  normalizeTimingDirectory,
  readTimingProcess,
  type TimingProcess,
  writeTimingDump,
} from './timing-dump.js';

/**
 * Which layer a recorded bracket belongs to.
 *
 * `base` and `closure` are the merge driver's two strata verbatim. `crawl` is the
 * incumbent link walker, which is not a projection contributor and has no
 * stratum of its own — see this module's header on synthetic ids.
 */
export type CrawlStratum = 'base' | 'closure' | 'crawl';

/** Every stratum, in the order the dump and every report list them. */
export const CRAWL_STRATA: readonly CrawlStratum[] = ['base', 'closure', 'crawl'];

/**
 * The `pass` a bracket placed INSIDE the measured code records.
 *
 * Reserved, and never produced by the merge driver, which numbers its passes from
 * 1. See this module's header: a contributor's own body does not know which
 * fixpoint pass is running, so a row keyed here aggregates across all of them and
 * says so by carrying a pass number no driver-placed row can carry.
 */
export const CRAWL_PASS_INSIDE = 0;

/** Synthetic contributor id for one whole `walkLinkGraph` call. */
export const CRAWL_WALKER_ID = 'walk-link-graph:walk';

/**
 * Synthetic contributor id for the link walker's gitignore oracle.
 *
 * Charged on the MISS path only — `WalkState.gitignoreFacts` memoizes the answer
 * within one walk, and a memo hit costs nothing worth a bracket. So `calls` here
 * counts oracle READS (a `git check-ignore` spawn, or a `GitTracker` active-set
 * lookup), not the number of times the cascade asked.
 */
export const CRAWL_WALKER_GITIGNORE_ID = 'walk-link-graph:gitignore';

/**
 * Synthetic contributor id for one `ClosureExtentContributor.contribute` call,
 * aggregated across every declared extent.
 *
 * Distinct from the driver's own `closure:<name>` rows, which are per extent and
 * per fixpoint pass: this one brackets the same work from the inside, so the two
 * together say how much of a contributor invocation is the contributor's body and
 * how much is the driver's merge and digest around it.
 */
export const CRAWL_CLOSURE_CONTRIBUTE_ID = 'closure-extent:contribute';

/** Synthetic contributor id for the closure walk's per-reference resolution. */
export const CRAWL_CLOSURE_RESOLVE_ID = 'closure-extent:resolve-reference';

/** One `(contributorId, stratum, pass)` row of the dump. */
export interface CrawlTimingEntry {
  /** A contributor's id, or one of this module's synthetic ids. */
  readonly contributorId: string;
  readonly stratum: CrawlStratum;
  /** The fixpoint pass, or {@link CRAWL_PASS_INSIDE}. */
  readonly pass: number;
  /** How many brackets were charged to this row. */
  readonly calls: number;
  /** Their summed wall time, in milliseconds. Unrounded. */
  readonly elapsedMs: number;
}

/** See {@link TimingProcess}. Lifetime figures, never a crawl duration. */
export type CrawlTimingProcess = TimingProcess;

/** The on-disk dump shape. Versioned so a reader can refuse an unknown layout. */
export interface CrawlTimingDump {
  dumpVersion: number;
  pid: number;
  /** See {@link CrawlTimingProcess}. Never summed across processes by any reader. */
  process: CrawlTimingProcess;
  /**
   * Every row, in a deterministic order: stratum first (declaration order),
   * then contributor id, then pass.
   *
   * **May be empty, and that is a real reading.** A command that crawled nothing
   * still files a dump — which is what keeps "this build has no seam" (no file at
   * all) distinguishable from "this command never reached a crawler" (a file with
   * no rows). Unlike the parse dump there is no fixed row set to emit at zero,
   * because the axis is open: there is no list of contributors a run "should"
   * have had.
   */
  entries: CrawlTimingEntry[];
}

/**
 * Bumped whenever the dump layout changes in a way a reader must notice.
 *
 * 1 — first version.
 */
const DUMP_VERSION = 1;

/** Basename stem of a dump file; the pid (and any collision counter) follow. */
const DUMP_BASENAME = 'crawl-timing';

/** What this seam is called in a failure line. */
const DUMP_NOUN = 'crawl-timing';

/** Mutable accumulator behind one row. */
interface EntryAccumulator {
  readonly contributorId: string;
  readonly stratum: CrawlStratum;
  readonly pass: number;
  calls: number;
  elapsedMs: number;
}

/**
 * Every row so far, keyed by `stratum|pass|contributorId`.
 *
 * The id goes LAST so the key needs no escaping: a stratum is one of three
 * literals and a pass is a number, so neither can contain the separator, and a
 * contributor id may then contain anything at all. (A `\0` separator would have
 * worked too and been unreadable — a file holding one is binary to `grep`, which
 * has cost this repo a confident zero more than once.)
 */
const entries = new Map<string, EntryAccumulator>();

/**
 * Where dumps go, or `null` when the seam is off.
 *
 * Read ONCE, here, from `process.env` — see this module's header.
 */
let dumpDirectory: string | null = normalizeTimingDirectory(process.env['VAT_CRAWL_TIMING']);

/**
 * The hot path's gate. A plain boolean rather than `dumpDirectory !== null` so
 * every instrumented call site costs one predictable branch on a memory load.
 */
let timingEnabled = dumpDirectory !== null;

/**
 * The accumulator key for one row.
 *
 * @param contributorId - A contributor's id or a synthetic one
 * @param stratum - Which layer
 * @param pass - The fixpoint pass, or {@link CRAWL_PASS_INSIDE}
 * @returns The map key
 */
function keyOf(contributorId: string, stratum: CrawlStratum, pass: number): string {
  return `${stratum}|${String(pass)}|${contributorId}`;
}

/**
 * Fold one measured invocation into its row.
 *
 * @param contributorId - A contributor's id or a synthetic one
 * @param stratum - Which layer
 * @param pass - The fixpoint pass, or {@link CRAWL_PASS_INSIDE}
 * @param elapsedMs - Wall time this invocation took
 */
function addEntry(
  contributorId: string,
  stratum: CrawlStratum,
  pass: number,
  elapsedMs: number,
): void {
  const key = keyOf(contributorId, stratum, pass);
  const bucket = entries.get(key);
  if (bucket === undefined) {
    entries.set(key, { contributorId, stratum, pass, calls: 1, elapsedMs });
    return;
  }
  bucket.calls += 1;
  bucket.elapsedMs += elapsedMs;
}

/**
 * Order the rows so two dumps of the same run list them identically.
 *
 * Stratum in declared order rather than alphabetically — `base` really does
 * precede `closure`, and sorting by name would put the walker's `crawl` rows
 * between them for no reason a reader could state.
 *
 * @param left - One row
 * @param right - Another
 * @returns Standard comparator ordering
 */
function compareEntries(left: EntryAccumulator, right: EntryAccumulator): number {
  const byStratum =
    CRAWL_STRATA.indexOf(left.stratum) - CRAWL_STRATA.indexOf(right.stratum);
  if (byStratum !== 0) return byStratum;
  const byId = left.contributorId.localeCompare(right.contributorId);
  if (byId !== 0) return byId;
  return left.pass - right.pass;
}

/**
 * Build the dump from the current accumulator state.
 *
 * @returns A snapshot of every row
 */
function buildDump(): CrawlTimingDump {
  return {
    dumpVersion: DUMP_VERSION,
    pid: process.pid,
    process: readTimingProcess(),
    entries: [...entries.values()].sort(compareEntries).map((entry) => ({ ...entry })),
  };
}

/**
 * Write the dump, if the seam is on.
 *
 * @returns The path written, or `null` when the seam is off or the write failed
 */
function writeDump(): string | null {
  return writeTimingDump(DUMP_NOUN, dumpDirectory, DUMP_BASENAME, buildDump);
}

if (dumpDirectory !== null) {
  ensureTimingDirectory(DUMP_NOUN, dumpDirectory);
  // Registered ONLY when enabled: a disabled seam must not even add a listener.
  process.on('exit', () => {
    writeDump();
  });
}

/**
 * Start a bracket.
 *
 * @returns `performance.now()` when the seam is on, `0` when it is off
 */
export function crawlTimingStart(): number {
  return timingEnabled ? performance.now() : 0;
}

/**
 * Attribute elapsed time to a `(contributorId, stratum, pass)` row.
 *
 * @param contributorId - A contributor's id, or one of this module's synthetic ids
 * @param stratum - Which layer the work belongs to
 * @param pass - The fixpoint pass, or {@link CRAWL_PASS_INSIDE} from inside the work
 * @param startedAt - The value {@link crawlTimingStart} returned
 */
export function recordCrawlPass(
  contributorId: string,
  stratum: CrawlStratum,
  pass: number,
  startedAt: number,
): void {
  if (!timingEnabled) return;
  addEntry(contributorId, stratum, pass, performance.now() - startedAt);
}

/**
 * Attribute an already-measured invocation, as the merge driver reports it.
 *
 * A second entry point rather than a second clock: the driver has to build a
 * `ContributorTiming` for its own `onContributorTiming` observer anyway, so it
 * measures once and hands the same object to both. Bracketing it here as well
 * would time the observer.
 *
 * @param timing - What one contributor invocation cost
 */
export function recordContributorInvocation(timing: {
  readonly contributorId: string;
  readonly stratum: CrawlStratum;
  readonly pass: number;
  readonly elapsedMs: number;
}): void {
  if (!timingEnabled) return;
  addEntry(timing.contributorId, timing.stratum, timing.pass, timing.elapsedMs);
}

/**
 * TEST ONLY. Turn the seam on (writing to `directory`) or off, and drop every
 * accumulated row.
 *
 * Exists so tests never have to mutate the real `process.env` — the same
 * justification `__setParseTimingForTest` states. It deliberately does NOT
 * register an `exit` listener; a test drives the write itself via
 * {@link __writeCrawlTimingDumpForTest}, so a test run never litters dumps.
 *
 * @param directory - Where {@link __writeCrawlTimingDumpForTest} writes, or `null` to disable
 */
export function __setCrawlTimingForTest(directory: string | null): void {
  dumpDirectory = normalizeTimingDirectory(directory ?? undefined);
  timingEnabled = dumpDirectory !== null;
  entries.clear();
  if (dumpDirectory !== null) ensureTimingDirectory(DUMP_NOUN, dumpDirectory);
}

/**
 * TEST ONLY. Read the accumulators without writing anything.
 *
 * @returns The dump that would be written right now
 */
export function __readCrawlTimingSnapshot(): CrawlTimingDump {
  return buildDump();
}

/**
 * TEST ONLY. Write a dump now, exactly as the exit listener would.
 *
 * @returns The path written, or `null` when the seam is off or the write failed
 */
export function __writeCrawlTimingDumpForTest(): string | null {
  return writeDump();
}
