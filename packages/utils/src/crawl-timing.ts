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
 * ## Why this seam lives in `utils` and not in the package that owns a crawler
 *
 * Every id below names work in some *other* package — `resources` builds the
 * registry, `agent-skills` walks the link graph, `claude-marketplace` enumerates
 * an inventory. The seam has to sit underneath all of them, and `utils` is the
 * only package that is underneath all of them.
 *
 * It shipped in `resources` and was moved here when {@link CRAWL_SHARED_GIT_TRACKER_ID}
 * needed a bracket, because the code that row measures — `GitTracker.initialize`
 * and its `git ls-files` spawn — is in *this* package, and `utils` may not import
 * `resources`. The alternative was a bracket at each of the six call sites that
 * construct a tracker, which is the arrangement the `ResourceRegistry` section
 * below rejects for exactly the reason it gives; and it would have reached only
 * five of them, because `@vibe-agent-toolkit/discovery` depends on `utils` alone
 * and could not have filed a row at all.
 *
 * ⚠️ What that costs, stated rather than glossed: {@link CrawlStratum}'s `base`
 * and `closure` are the merge driver's names, and the driver is two packages up.
 * A module here now carries vocabulary from above it. That is a naming coupling
 * and not a code one — nothing in this file or {@link timing-dump} imports
 * anything but `node:` builtins and this package's own path helpers — but a
 * reader looking for why `utils` knows the word "fixpoint" is owed the answer.
 *
 * ## What a `stratum` is here, and why the walker and the tracker get their own
 *
 * Two of the four come straight from the merge driver: `base` contributors run
 * once, `closure` contributors iterate to a fixed point. `walkLinkGraph` is
 * neither — it is not a projection contributor at all and the driver never sees
 * it — so it records under `crawl` with a **synthetic contributor id**
 * ({@link CRAWL_WALKER_ID}, {@link CRAWL_WALKER_GITIGNORE_ID}). That is stated
 * here, and named in constants, rather than left to whatever string a call site
 * happened to pass: a synthetic id that arrives by accident is indistinguishable
 * in the dump from a real contributor, and the whole point of the dump is that
 * the two crawlers are legible side by side.
 *
 * The fourth, `shared`, is for work **neither arm owns and both consume** — see
 * its own section below. It exists because the only honest place to charge such
 * work is a stratum that belongs to nobody: charging it to `crawl` would put
 * shared preparation on the incumbent's total, which is the same class of defect
 * as the double-count described further down, with the arms swapped.
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
 * - **Neither arm** = the `shared` stratum. It is part of what the COMMAND cost
 *   and no part of what either crawler cost, so it belongs in a command total and
 *   in neither side of the side-by-side. A reader who adds it to one arm has
 *   answered a different question than the one they asked.
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
 * ## `shared` is for preparation that CANCELS, and cancelling is not free
 *
 * A `GitTracker` is built once and handed to whichever crawler runs: both arms
 * take one as a caller option, so the `git ls-files` spawn behind it is charged
 * to the same side whichever way a verb is flipped. It is therefore invisible to
 * the arm COMPARISON by construction — and it was, for four commits, invisible
 * to the dump as well, which is a different and worse thing.
 *
 * The distinction the `shared` stratum draws is between two questions a reader
 * asks with the same words:
 *
 * - *"Which crawler costs more?"* — `shared` is irrelevant, and adding it to
 *   either arm makes the answer wrong.
 * - *"What did this command spend finding documents?"* — `shared` is part of the
 *   answer, and omitting it makes THAT answer wrong. On an adopter monorepo one
 *   `GitTracker.initialize()` measured 147 ms; the whole incumbent crawl on VAT's
 *   own tree measures ~75 ms. A term that can be twice the total it is missing
 *   from is not a rounding error.
 *
 * Symmetric under-counting is still under-counting. The rule this seam keeps is
 * that no measured work goes unrecorded, and where a row is placed is answered
 * separately from whether it exists.
 *
 * ⚠️ `shared` is a FALLBACK, not a destination. {@link recordSharedPass} inherits
 * {@link withContributorStratum} exactly as {@link recordRegistryPass} does, for
 * the same reason: a projection contributor that built its own tracker would be
 * paying for it out of its own time, and charging that to `shared` would move a
 * cost off the arm that actually incurred it. Nothing shipped does — the base
 * contributors are handed a tracker rather than building one — but "nothing does
 * yet" is not an accounting rule, and it is the rule this whole file is about.
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
 *
 * `shared` is the odd one out and is meant to be: it holds work that BOTH arms
 * consume and NEITHER owns, so it belongs to a command's total and to no side of
 * the side-by-side. See this module's `shared` section for why a stratum that
 * cancels out of the comparison still has to exist.
 */
export type CrawlStratum = 'base' | 'closure' | 'crawl' | 'shared';

/**
 * Every stratum, in the order the dump and every report list them.
 *
 * `shared` is appended rather than slotted next to `crawl`, so that adding it did
 * not reorder a single existing row. Dump ordering is what makes two captures of
 * one run comparable line by line, and a reordering is indistinguishable from a
 * measurement change to anything diffing the text.
 */
export const CRAWL_STRATA: readonly CrawlStratum[] = ['base', 'closure', 'crawl', 'shared'];

/**
 * The strata the merge driver actually runs a contributor in.
 *
 * Spelled out rather than derived as `Exclude<CrawlStratum, 'crawl'>`, which is
 * what it used to be: that subtraction was correct only while `crawl` was the one
 * stratum with no driver behind it, and `shared` silently joined the set the day
 * it was added. A type that grows a member every time an unrelated one is added
 * is a type that will eventually admit a value nothing can produce.
 */
export type CrawlDriverStratum = 'base' | 'closure';

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
 * Synthetic contributor id for one run of the merge driver's blob stage —
 * `populateBlobs`, which reads and parses every path the base contributors keyed
 * and derives the four blob-keyed tables from it.
 *
 * **This is the projection's analogue of {@link CRAWL_REGISTRY_ADD_RESOURCE_ID},
 * and it went uncharged while that one was charged.** The asymmetry is why the
 * bracket exists: the seam's whole purpose is "which of the two crawlers costs
 * more to do its own work", and an omission on ONE arm biases exactly that
 * comparison — unlike {@link CRAWL_SHARED_GIT_TRACKER_ID}, whose omission at
 * least cancelled. It is latent only while `populate()` has no production caller;
 * the increment that gives it one is the increment that would have read a
 * projection total with its own parse stage missing from it.
 *
 * Charged in `base` at the driver's pass, NOT at {@link CRAWL_PASS_INSIDE}: the
 * stage is placed BY the driver, between the strata, and a pass-0 row in a driver
 * stratum means "a bracket inside a contributor invocation", which this is not.
 * Pass >= 1 is what makes it additive, and additive is correct — nothing else
 * brackets this time.
 *
 * Both driver-placed runs file this one row: the stage before the closure
 * iterates, and the post-promotion run after it. Same accounting unit and the
 * same argument {@link CRAWL_REGISTRY_ENUMERATE_ID} makes for its two routes, so
 * `calls` reads as "how many times the stage ran" (1, or 2 when a closure
 * contributor promoted a demand) and stays divisible.
 */
export const CRAWL_BLOB_POPULATE_ID = 'blob-population:derive';

/**
 * Synthetic contributor id for one `GitTracker.initialize()` — the `git ls-files`
 * spawn and the active-set, ancestor and index maps built from its output.
 *
 * The default stratum is `shared` because a tracker is preparation both crawlers
 * consume and neither owns; see this module's `shared` section.
 *
 * **`calls` counts real initializations, not calls to the method.** `initialize`
 * returns immediately once it has run, and a bracket around that early return
 * would report a caller's re-entry as work. Same rule as
 * {@link CRAWL_WALKER_GITIGNORE_ID}, which counts oracle reads rather than
 * questions asked, and for the same reason: a `calls` column nobody can divide by
 * is a column that misleads.
 *
 * ⚠️ **The `new GitTracker(...)` constructor is deliberately NOT charged.** It
 * resolves one path and allocates four empty containers; a bracket around it
 * would measure `performance.now()` twice and file the result as a finding. This
 * row is named "initialize" rather than "build" so it does not imply otherwise.
 * A tracker that is constructed and never initialized therefore files no row,
 * which is correct — it also spawned nothing.
 */
export const CRAWL_SHARED_GIT_TRACKER_ID = 'git-tracker:initialize';

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
const contributorStratum = new AsyncLocalStorage<CrawlDriverStratum>();

/**
 * Every synthetic id this BUILD is able to charge, whether or not it did.
 *
 * ## Why a dump has to say this, and why the version number could not
 *
 * An absent row is ambiguous in the one way that matters to a comparison: a dump
 * with no `git-tracker:initialize` row is either a build that has no such bracket
 * or a build that has one and never initialized a tracker. **The entries cannot
 * distinguish those, and the difference decides whether two dumps are comparable
 * at all** — the first case means one arm's total is missing a term the other
 * arm's total contains, which is a widening read as a movement; the second means
 * the arms agree and the work genuinely did not happen.
 *
 * {@link CRAWL_SEAM_DUMP_VERSION} was the previous answer and it is a poor one.
 * An integer says "different", never "different how", so the remedy for a real
 * widening and for a typo'd field is the same blunt refusal — and, worse, it only
 * fires if a human remembers to bump it. The `shared` stratum shipped without a
 * bump on an argument that was correct about rows and wrong about totals; nothing
 * mechanical caught that, because nothing mechanical could.
 *
 * This list is derived from the module's own constants and travels in the dump,
 * so a reader diffs CAPABILITIES rather than comparing an opaque number, and a
 * bracket added here is announced without anyone remembering anything.
 *
 * ⚠️ **Synthetic ids only.** A contributor's own id comes out of a corpus's
 * config (`closure:<name>`) and is not a property of the build, so it cannot go
 * here — its absence really does mean "that extent was not declared", which is a
 * corpus difference and not a build one. The strata are declared alongside, in
 * {@link CRAWL_STRATA}, for the same reason and with no such caveat.
 */
export const CRAWL_CHARGEABLE_IDS: readonly string[] = [
  CRAWL_BLOB_POPULATE_ID,
  CRAWL_CLOSURE_CONTRIBUTE_ID,
  CRAWL_CLOSURE_RESOLVE_ID,
  CRAWL_REGISTRY_ADD_RESOURCE_ID,
  CRAWL_REGISTRY_ENUMERATE_ID,
  CRAWL_REGISTRY_RESOLVE_LINKS_ID,
  CRAWL_SHARED_GIT_TRACKER_ID,
  CRAWL_WALKER_GITIGNORE_ID,
  CRAWL_WALKER_ID,
];

/**
 * What a build can charge, as the dump carries it.
 *
 * Static per build — read from constants at write time, never accumulated — so
 * it describes the INSTRUMENT and never the run. That is the whole point: it is
 * the half of the dump that is still true when every row is absent.
 */
export interface CrawlTimingCharges {
  /** Every stratum this build can file a row in. */
  readonly strata: readonly string[];
  /** Every synthetic id this build can file a row under. */
  readonly syntheticIds: readonly string[];
}

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
   * What this build can charge — see {@link CRAWL_CHARGEABLE_IDS}.
   *
   * Present even when `entries` is empty, and that is the case it exists for: a
   * dump with no rows still says which brackets the build carries, so a reader
   * can tell "this instrument cannot see that work" from "that work did not
   * happen".
   */
  charges: CrawlTimingCharges;
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
 *
 * 3 — the `shared` stratum, and the projection's blob stage
 *     ({@link CRAWL_BLOB_POPULATE_ID}). No field changed here either, and that
 *     is exactly why the first attempt at this entry argued no bump was needed:
 *     `shared` holds work previously charged NOWHERE, so nothing moved out of an
 *     existing row, and a reader predating it buckets the rows in
 *     `unclassified`. That argument was **right about rows and wrong about the
 *     dump**, because the rule above says "the meaning of a row" and the values a
 *     reader actually publishes are DERIVED:
 *
 *     - a command TOTAL sums every additive row across every stratum, so it grew
 *       by the whole `git ls-files` spawn — 27% to 100% of the crawl budget
 *       depending on the corpus. An A/B across the boundary sees that as a real,
 *       and perfectly STABLE, regression: every pair says `changed` for the same
 *       reason, which reads as agreement rather than as the tool refusing.
 *     - `attribution` flips from `nothing-crawled` to `measured` for a command
 *       that reached no crawler at all, because one shared row is now present.
 *
 *     Both are precisely the v1 -> v2 failure — a widening read as a movement —
 *     so both get the same remedy. A reader that refuses the dump and says so is
 *     the loud failure; a reader that publishes a confident false delta is the
 *     quiet one, and the quiet one is what shipped between these two versions.
 * 4 — the dump gained {@link CrawlTimingDump.charges}, and this number stops
 *     being the mechanism. A layout change, so it costs one last bump; after it,
 *     a reader diffs what two builds can CHARGE instead of comparing an integer,
 *     and a widening announces itself without anyone remembering to bump
 *     anything. Read {@link CRAWL_CHARGEABLE_IDS} for why the integer could never
 *     have done that job — it says "different", never "different how", and the
 *     v3 entry above exists precisely because a human did not notice in time.
 *
 * ⚠️ Keep bumping this for LAYOUT changes; it is still the only thing that can
 * refuse a dump whose fields moved. What it is no longer responsible for is
 * meaning, which the dump now states for itself.
 */
export const CRAWL_SEAM_DUMP_VERSION = 4;

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
    charges: { strata: [...CRAWL_STRATA], syntheticIds: [...CRAWL_CHARGEABLE_IDS] },
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
 * Attribute elapsed time to whichever arm invoked this work, falling back to a
 * stratum the work belongs to when no arm did.
 *
 * **No `stratum` parameter from the CALL SITE, deliberately.** The measured code
 * here — a registry build, a tracker initialization — does not know whether it is
 * running for the incumbent walker or from inside a projection contributor, and a
 * call site that names a stratum it cannot know is how the work of one arm ends up
 * on the other's total. The answer comes from {@link withContributorStratum}
 * instead.
 *
 * The `fallback` is what the work is when nobody claimed it, and it is per site
 * rather than a constant: an unclaimed registry build was the incumbent preparing
 * to walk (`crawl`), while an unclaimed tracker build was preparation for whoever
 * runs (`shared`). One function with a parameter rather than two nearly identical
 * ones — the branch is the only difference between them, and two copies would be
 * two places for the inheritance rule to drift.
 *
 * @param contributorId - One of this module's synthetic ids
 * @param startedAt - The value {@link crawlTimingStart} returned
 * @param fallback - The stratum to charge when no contributor is on the stack
 */
function recordInheritedPass(
  contributorId: string,
  startedAt: number,
  fallback: CrawlStratum,
): void {
  const stratum = contributorStratum.getStore() ?? fallback;
  addEntry(contributorId, stratum, CRAWL_PASS_INSIDE, performance.now() - startedAt);
}

/**
 * Attribute elapsed time to one of the `ResourceRegistry` phases, under whichever
 * arm invoked it — the incumbent when none did.
 *
 * @param contributorId - One of this module's `resource-registry:` ids
 * @param startedAt - The value {@link crawlTimingStart} returned
 */
export function recordRegistryPass(contributorId: string, startedAt: number): void {
  if (!timingEnabled) return;
  recordInheritedPass(contributorId, startedAt, 'crawl');
}

/**
 * Attribute elapsed time to preparation both arms consume, under whichever arm
 * invoked it — `shared` when none did, which is the shipped case.
 *
 * See this module's `shared` section: the fallback is the point of this entry
 * point, and the inheritance is what keeps it from becoming a place to hide a
 * cost one arm really did incur.
 *
 * @param contributorId - One of this module's shared ids
 * @param startedAt - The value {@link crawlTimingStart} returned
 */
export function recordSharedPass(contributorId: string, startedAt: number): void {
  if (!timingEnabled) return;
  recordInheritedPass(contributorId, startedAt, 'shared');
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
  stratum: CrawlDriverStratum,
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
