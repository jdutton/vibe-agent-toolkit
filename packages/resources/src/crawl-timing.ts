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
 * ## The two arms are bracketed at the same DEPTH, and that took a fix
 *
 * "Side by side" is a claim about depth, not just about presence. This seam
 * shipped with the projection arm bracketed at its driver — `merge.ts` charges
 * every `base` contributor, so the `base` stratum carries the projection's whole
 * PREPARATION — while the incumbent arm was bracketed only at
 * {@link CRAWL_WALKER_ID}, one `walkLinkGraph` call. But `walkLinkGraph` walks a
 * `ResourceRegistry` somebody else already built, and building it is the crawl:
 * `crawlDirectory` to enumerate, one read-parse-index per file to admit, then
 * `resolveLinks` to wire the graph the walk then follows. None of that was
 * charged anywhere. Measured on a real subject, the walker's traversal came in at
 * **1.7 ms** against the projection's ~1,016 ms — and nothing in the output looked
 * wrong, because both numbers were real and both arms reported. A ~600× ratio
 * read off that dump would have been a comparison of a walk against a whole
 * crawl.
 *
 * So the registry's own work is charged under `crawl` too
 * ({@link CRAWL_REGISTRY_ENUMERATE_ID}, {@link CRAWL_REGISTRY_ADD_RESOURCE_ID},
 * {@link CRAWL_REGISTRY_RESOLVE_LINKS_ID}), and the brackets live INSIDE
 * `ResourceRegistry` rather than at the six sites that construct one. Six copies
 * of the same bracket is six chances to disagree, and a seventh construction site
 * added later would silently rot the gate — the one place all six converge is the
 * class itself.
 *
 * ### How to total an arm from this dump
 *
 * Not every row is additive with every other, so the two totals a flip decision
 * rests on are stated here rather than left to a reader's arithmetic:
 *
 * - **Incumbent arm** = the three `resource-registry:*` rows (mutually disjoint —
 *   enumeration, admission and link resolution do not contain one another) plus
 *   {@link CRAWL_WALKER_ID}. **Not** {@link CRAWL_WALKER_GITIGNORE_ID}, which is
 *   charged from inside the walk and is therefore already inside the walk's row.
 * - **Projection arm** = the driver-placed rows in `base` and `closure`, i.e.
 *   every row at pass ≥ 1. The pass-0 rows in those strata
 *   ({@link CRAWL_CLOSURE_CONTRIBUTE_ID}, {@link CRAWL_CLOSURE_RESOLVE_ID}, and a
 *   registry build reached from inside a contributor) are breakdowns of that same
 *   time, not additions to it.
 *
 * ⚠️ A rollup that sums a stratum's rows without regard to pass double-counts
 * every nested bracket. That is a real reading hazard, not a hypothetical: it is
 * what `packages/lab/src/facets/crawl/dump.ts` did until 2026-08-15, and it
 * inflated the two arms by DIFFERENT factors, because they nest to different
 * depths. That reader now implements the rule above — `crawlRowRole` there is
 * the executable copy of it — so anyone adding a bracket to this seam should
 * expect to place it there too, and will see it land in `unclassified` if they
 * do not.
 *
 * ## A registry built from inside a contributor belongs to the PROJECTION arm
 *
 * Putting the bracket inside `ResourceRegistry` puts it under whoever calls it,
 * and a projection contributor could call it. Nothing shipped does — no file
 * under `src/projection/` imports the class; the base contributors reach for
 * `crawlDirectory`, `GitTracker` and `node:fs` directly — but "nothing does yet"
 * is not an accounting rule. If a contributor ever did, charging its registry
 * build to `crawl` would move a whole crawl onto the incumbent's total on a run
 * the incumbent took no part in: the same defect this section describes, with the
 * arms swapped.
 *
 * So a registry bracket does not name its own stratum. It **inherits** the one
 * the merge driver is running under ({@link withContributorStratum}, an
 * `AsyncLocalStorage` so it survives the `await`s a contributor is full of and
 * cannot be corrupted by a second population interleaving with the first), and
 * falls back to `crawl` — the incumbent — when no contributor is on the stack.
 * The row is then a pass-0 breakdown of the driver's own row for that
 * contributor, exactly as {@link CRAWL_CLOSURE_CONTRIBUTE_ID} already is.
 *
 * **Failure mode of that choice, stated plainly:** the inherited row overlaps the
 * driver's row for the same invocation, so an arm total that adds them
 * double-counts. The alternative — dropping the bracket while inside a
 * contributor — would have removed the overlap by making real work invisible,
 * and an absent row is indistinguishable from code that never ran. Overlap that
 * a reader can see and the totalling rule above resolves beats a silent hole.
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

import { AsyncLocalStorage } from 'node:async_hooks';

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
 * incumbent crawler — the `ResourceRegistry` build AND the `walkLinkGraph` call
 * that consumes it, which together are the same span of work the projection's two
 * strata are. Neither is a projection contributor and neither has a stratum of its
 * own, so both record under synthetic ids; see this module's header.
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

/**
 * What every `ResourceRegistry` id starts with.
 *
 * Exported because "is this row registry preparation?" is a question a reader
 * asks — the three phases are one accounting unit — and a caller answering it by
 * restating the prefix would drift the moment a fourth phase is bracketed.
 */
export const CRAWL_REGISTRY_ID_PREFIX = 'resource-registry:';

/**
 * Synthetic contributor id for the enumeration inside `ResourceRegistry.crawl` —
 * the `crawlDirectory` call, and nothing that follows it.
 *
 * Only the enumeration, so that this row and
 * {@link CRAWL_REGISTRY_ADD_RESOURCE_ID} are additive rather than nested:
 * `crawl()` is enumeration THEN admission, and bracketing the whole method would
 * have produced a row that contains the admission row.
 *
 * A caller that enumerates for itself and hands paths to `addResources` files no
 * row from inside the class, because its `crawlDirectory` call is outside the
 * registry and therefore outside this bracket. That is a property of the class,
 * not a claim that such a route enumerated nothing, and it is pinned as such in
 * `crawl-timing.test.ts`.
 *
 * One such route ships: the marketplace inventory's `crawlSkillLinkRegistry`,
 * which is the registry `vat inventory` hands the incumbent walker. It brackets
 * its own enumeration and files this same row — the same accounting unit, and the
 * two can never both run for one registry, so they cannot double-charge. It has
 * to, because that registry is built for the INCUMBENT and never for the
 * projection: unbracketed, it is a one-sided under-count on exactly the arm the
 * flip decision is taken against, which is worse than a symmetric one.
 */
export const CRAWL_REGISTRY_ENUMERATE_ID = 'resource-registry:enumerate';

/**
 * Synthetic contributor id for one `ResourceRegistry.addResource` — the read, the
 * content key, the parse, the stat, the checksum and the four index writes for
 * one file.
 *
 * The per-file grain is deliberate. It is the only grain every construction route
 * shares (`crawl` and a direct `addResources` both funnel through it), and it is
 * the one that makes the row's ms/call comparable to a projection contributor's:
 * this is what admitting a document costs the incumbent.
 *
 * Charged even when the admission FAILS — a duplicate-id drop and an unreadable
 * file both cost the read and the parse before they are refused, and a seam that
 * charged only successes would report a corpus of collisions as nearly free.
 */
export const CRAWL_REGISTRY_ADD_RESOURCE_ID = 'resource-registry:add-resource';

/** Synthetic contributor id for one whole `ResourceRegistry.resolveLinks` call. */
export const CRAWL_REGISTRY_RESOLVE_LINKS_ID = 'resource-registry:resolve-links';

/**
 * The stratum the merge driver is currently running a contributor under, or
 * absent outside a contributor invocation.
 *
 * `AsyncLocalStorage` rather than a module-level variable because a contributor
 * is a chain of `await`s: a plain flag set before the call and cleared after it
 * would be observed by any other crawl that happened to resume on the event loop
 * in between, and two populations in one process would corrupt each other's
 * attribution. See this module's header for why the inheritance exists at all.
 */
const contributorStratum = new AsyncLocalStorage<Exclude<CrawlStratum, 'crawl'>>();

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
 * Bumped whenever the dump's layout — **or the meaning of a row already in it** —
 * changes in a way a reader must notice.
 *
 * The meaning half is not pedantry. A reader that refuses an unknown layout but
 * accepts a silently redefined row is worse than one that refuses both: it
 * produces numbers, and nobody can state what they are of.
 *
 * 1 — first version.
 * 2 — the `crawl` stratum gained the incumbent's PREPARATION
 *     (`resource-registry:*`). No field changed. What changed is what a `crawl`
 *     total is a total OF: traversal alone at v1, the registry build plus the
 *     traversal at v2. Holding a v1 dump against a v2 one reads that widening as
 *     a several-hundred-fold regression in the walker — see this module's header.
 */
export const CRAWL_SEAM_DUMP_VERSION = 2;

/**
 * Alias kept for this module's own readability at the write site.
 *
 * ⚠️ The exported spelling above exists so the READER can pin itself against the
 * writer. `@vibe-agent-toolkit/lab`'s `CRAWL_DUMP_VERSION` refuses any dump whose
 * version it does not recognise, and the two used to be unrelated literals in
 * two packages — drift was silent, and its symptom is not a subtly wrong number
 * but **every dump getting refused**, which a reader would sooner blame on their
 * own invocation than on a constant. Now the lab pins equality against this
 * export, so a bump here that is not mirrored there fails a test instead.
 */
const DUMP_VERSION = CRAWL_SEAM_DUMP_VERSION;

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
 * Attribute elapsed time to one of the `ResourceRegistry` phases, under whichever
 * arm invoked it.
 *
 * **No `stratum` parameter, deliberately.** A registry does not know whether it
 * is being built for the incumbent walker or from inside a projection
 * contributor, and a call site that names a stratum it cannot know is how the
 * work of one arm ends up on the other's total. The answer comes from
 * {@link withContributorStratum} instead, defaulting to `crawl`.
 *
 * @param contributorId - One of this module's `resource-registry:` ids
 * @param startedAt - The value {@link crawlTimingStart} returned
 */
export function recordRegistryPass(contributorId: string, startedAt: number): void {
  if (!timingEnabled) return;
  const stratum = contributorStratum.getStore() ?? 'crawl';
  addEntry(contributorId, stratum, CRAWL_PASS_INSIDE, performance.now() - startedAt);
}

/**
 * Run one contributor invocation with its stratum on the async context, so any
 * bracket reached from inside it is attributed to the projection arm.
 *
 * A pass-through when the seam is off: an `AsyncLocalStorage.run` per contributor
 * is cheap, but the shipped default is "no instrumentation ran at all", and this
 * keeps that literally true.
 *
 * @param stratum - The stratum the driver is running this contributor in
 * @param run - The invocation
 * @returns Whatever the invocation returns
 */
export function withContributorStratum<T>(
  stratum: Exclude<CrawlStratum, 'crawl'>,
  run: () => Promise<T>,
): Promise<T> {
  if (!timingEnabled) return run();
  return contributorStratum.run(stratum, run);
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
