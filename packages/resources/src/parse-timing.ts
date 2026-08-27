/**
 * Sub-phase timing accumulators for VAT's document parse paths.
 *
 * VAT already reports per-PHASE timing. What nothing could observe is which
 * pass *inside* a parser spends the time — attributing one recent parse
 * regression cost 24 cold measurement runs plus a hand-edited throwaway probe.
 * This seam answers the same question in one run.
 *
 * ## Two parser kinds, each instrumented on its own terms
 *
 * VAT parses two kinds of document, and they share no passes: markdown goes
 * through remark, HTML through parse5. Both are instrumented here.
 *
 * Instrumenting only markdown was a generalisation from one corpus. On a
 * markdown-dominant tree the HTML parses are a rounding error, and treating them
 * as an unattributed residual looks harmless; on an HTML-heavy tree the same
 * instrument attributes almost none of the real parse work and still emits a
 * confident, well-formed breakdown. A blind instrument that reports a number is
 * worse than one that reports nothing, so the fix is to see both kinds rather
 * than to name what the first one missed.
 *
 * The two kinds are **not** forced into a common pass list. HTML has no
 * frontmatter, no reference-link scan and no code fences; a shared eight-slot
 * shape would be a costume with four permanently-zero rows in it. Each kind
 * declares the passes it actually has, and shares a name (`estimate-tokens`,
 * `measure-content`) only where it genuinely runs the same operation.
 *
 * ## Accumulators, not spans
 *
 * The parsers run 1,364+ times per vat command on a large tree, so a per-event
 * span object would allocate ~12,000 objects per run and change the very thing
 * it measures. Instead there are two module-level `Float64Array`s — elapsed ms
 * and call count, indexed by {@link ParsePass}, one flat slot space covering
 * both kinds — summed in place and dumped ONCE at process exit.
 *
 * Timing comes from `performance.now()` (a float, no allocation) rather than
 * `process.hrtime.bigint()`, which allocates a BigInt per call.
 *
 * ## Why the dump groups the passes, and puts each total OUTSIDE its group
 *
 * The dump's `kinds` array carries one group per parser kind, and each group
 * holds its own `documents`, its own `passes` and its own `total` — the total in
 * a **field of its own, never as a row among the passes**. That shape is chosen
 * so a reader cannot compute a wrong answer by summing what is in front of them:
 * summing a group's `passes` yields its attributed time (right), summing every
 * group's `passes` yields all attributed parser time (also right), and there is
 * no arrangement of rows that silently double-counts a bracket. The remainder a
 * reader wants — time nothing accounted for — is only computable against the
 * total that sits beside the rows, per kind, which is the only place it means
 * anything.
 *
 * Each total still carries a self-describing NAME (`markdown-total`,
 * `html-total`) rather than a bare `total`, so a row lifted out of its group is
 * still unambiguous about which bracket it is.
 *
 * `kinds` is ALWAYS every kind in the declared order, and each group ALWAYS
 * carries all of its passes in the declared order, even when a count is 0 — a
 * reader never has to distinguish "absent" from "zero".
 *
 * ## What the counts do and do not reconcile
 *
 * `cache.hits`/`cache.misses` count every parser kind, because `parseKeyed`
 * routes both kinds through one cache. Document counts are now per kind, so the
 * cache's population and the parsers' population are finally comparable — but
 * they are still **not** equal, and nothing here derives one from the other:
 * several call sites (`parseMarkdown(filePath)`, `parseHtml(filePath)`) reach a
 * parser without consulting the cache at all, so the parse counts can exceed the
 * misses. Every term is recorded where the work happens; what is left over is
 * left to a reader who now has all of them.
 *
 * ## Why the process-level CPU reading is one syscall and the passes are not
 *
 * The passes are WALL-timed on purpose: `process.cpuUsage()` around every pass
 * over 1,400+ documents is ~12,000 syscalls and would become the cost it set out
 * to measure. But the *process* number is one call at exit, and it is what tells
 * a reader whether to trust the wall figures at all: a run whose wall time
 * greatly exceeds its CPU time was waiting — a loaded machine or an I/O-bound
 * process — and every per-pass wall figure carries that waiting inside it.
 * `process.wallMs` is the process's whole lifetime, not the parse's; it is a
 * denominator for the divergence, never a parse duration.
 *
 * ⚠️ That denominator is only meaningful PER PROCESS, which is why exactly one
 * thread reads it and exactly one file carries it — see {@link ParseTimingDump}.
 * A reader that summed one process's lifetime once per thread would divide CPU
 * by a denominator too large by the pool's width, and the result reads as a
 * performance regression of that factor.
 *
 * The question this seam does NOT answer is several PROCESSES of one run: an
 * orchestrator's lifetime contains its children's, so summing those
 * double-counts real time. `vat validate`, `vat verify` and `vat build` run
 * their phases in-process, so there is one process to report and the case is
 * vacant rather than solved.
 *
 * ## Why the gate is read at module load — and why that does not contradict
 * `parse-cache.ts`
 *
 * `parse-cache.ts` reads its env var per *construction*, never at module load,
 * on the stated grounds that a module-level read is unobservable to a caller
 * who sets the variable later and untestable without mutating the real
 * `process.env`. That rule is right for a class a caller constructs; it is
 * wrong here, because this gate sits on a path taken 1,364+ times per command
 * and `process.env` access in Node is a **native call**, not a property read.
 *
 * The two concerns are reconciled rather than traded off:
 *
 * - `process.env['VAT_PARSE_TIMING']` is read exactly once, at module load,
 *   into a module-level binding.
 * - The hot path reads that binding — a memory load — and never `process.env`.
 * - {@link __setParseTimingForTest} lets a test enable, disable and reset the
 *   seam without mutating the real environment, which is precisely the
 *   testability property `parse-cache.ts`'s rule was protecting. (It is also
 *   the only way to test this at all: `vitest.setup.js` deletes every `VAT_*`
 *   variable before any test module loads.)
 *
 * The env var's VALUE is the directory the dump is written to; its presence is
 * what enables the seam. An empty-string value counts as absent.
 */

import { isMainThread, threadId } from 'node:worker_threads';

import {
  ensureTimingDirectory,
  normalizeTimingDirectory,
  readTimingProcess,
  type TimingProcess,
  writeTimingDump,
} from '@vibe-agent-toolkit/utils';

/**
 * The passes the instrumented parsers are bracketed at, as array indices.
 *
 * ONE flat slot space across both parser kinds, so the hot path indexes a
 * `Float64Array` directly and no per-kind lookup happens per call. Which slots
 * belong to which kind — and what each is called in the dump — lives in
 * {@link PARSE_KIND_SHAPES}, and `parse-timing.test.ts` pins the two against
 * each other so a slot added here cannot drift out of the dump.
 */
export const ParsePass = {
  // Markdown — `parseMarkdownContent` in link-parser.ts.
  EstimateTokens: 0,
  RemarkProcessor: 1,
  RemarkParse: 2,
  /**
   * A redundant micromark tokenize, charged only when the split probe is on.
   *
   * Sits beside {@link RemarkParse} rather than inside it: the two brackets
   * overlap in meaning, not in time, and tree building is the SUBTRACTION of
   * this row from that one. See `parse-tokenize-probe.ts` for why the tokenize
   * is measured and the tree build derived, and why this row is normally 0.
   */
  MicromarkTokenize: 3,
  AstFacts: 4,
  UnresolvedReferences: 5,
  CodeContextRanges: 6,
  LexicalReferences: 7,
  MeasureContent: 8,
  /** Brackets the whole markdown parse. Always last in its group. */
  MarkdownTotal: 9,

  // HTML — `parseHtmlContent` in html-link-parser.ts.
  HtmlParse: 10,
  HtmlElementWalk: 11,
  HtmlEstimateTokens: 12,
  HtmlMeasureContent: 13,
  /** Brackets the whole HTML parse. Always last in its group. */
  HtmlTotal: 14,
} as const;

/**
 * One of {@link ParsePass}'s slot indices.
 *
 * Named apart from the value rather than declaration-merged with it: the base
 * `no-redeclare` rule is on in this repo and does not understand TS's
 * type/value merge.
 */
export type ParsePassSlot = (typeof ParsePass)[keyof typeof ParsePass];

/**
 * Which parser produced a document, as an array index.
 *
 * Numeric for the same reason {@link ParsePass} is: the document counters are
 * `Float64Array`s and the recording call site is hot.
 *
 * ⚠️ **Not** `content-key.ts`'s `ParserKind`, which shares the name and is a
 * different set. That one is a ROUTING answer and has a third member, `none`,
 * naming the absence of a parser. This one enumerates *instrumented parsers*, so
 * `none` has no slot here.
 *
 * 🚨 **The reason it has no slot is NOT that nothing runs.** That claim stood
 * here and was false, because there are two `none` routes and it described only
 * the cheap one:
 *
 * - `resource-registry.ts`'s `unparsedResourceFacts` runs `estimateTokens` and
 *   nothing else. ✅ Effectively free, and nothing worth bracketing.
 * - `projection/blob-population.ts`'s `unparsedFacts` runs **three real passes
 *   over the full content** — `findLexicalReferences`, `measureContent` and
 *   `estimateTokens` — on every non-prose file. ❌ That work is real, it is
 *   unattributed, and it is the lane `claude context`, `claude budget` and cold
 *   population all use.
 *
 * The gap is **bounded, not zero**: the same three passes measured 605 ms +
 * 469 ms + 0.585 ms over 8,713 documents / 108.9 MB, so on an adopter tree whose
 * `none` route now covers ~77 MB it is ~0.8 s against a 16 s cold run — under 5%,
 * while `remark-parse` is 55%. Small enough that no parse-budget conclusion has
 * turned on it so far; large enough that "nothing runs" must not be written here
 * again.
 *
 * ⛔ Whether to add a third group is a **live decision, not an oversight**, and
 * it is not free: a third group changes the dump's shape, so `lab`'s strict dump
 * schema refuses every dump written before it and its strict body schema refuses
 * every stored report — automatically, and with nobody to remember anything.
 * `parse-timing.test.ts` pins the exclusion deliberately.
 * Until it is taken, the renderer names its denominator as the parsed subset so
 * the omission cannot read as a measurement of the whole tree.
 */
export const ParserKind = {
  Markdown: 0,
  Html: 1,
} as const;

/** One of {@link ParserKind}'s slot indices. */
export type ParserKindSlot = (typeof ParserKind)[keyof typeof ParserKind];

/**
 * Work the parse TIER does around a parse, as array indices.
 *
 * ## Why this is a top-level section and not a third `kinds[]` entry
 *
 * Reusing {@link ParseKindShape} would have been cheapest, and it is wrong.
 * {@link PARSE_KIND_SHAPES} is documented as positionally aligned with
 * {@link ParserKind} and `parse-timing.test.ts` pins that length — but the real
 * objection is semantic: every consumer reads `kinds` as *parser* kinds, so a
 * cache read or a `postMessage` folded in there would land inside "which parser
 * dominates this tree". That is the denominator bug `ca99aedb` fixed one level
 * up, reintroduced one level down. The codebase already paid to learn it.
 *
 * So tier work gets its own bracket, in its own accumulators, beside `kinds` and
 * never inside it. `kinds` keeps meaning exactly "parser kinds", and the
 * per-group "the total brackets its passes" invariant stays true because nothing
 * was added to a group.
 *
 * ## Why there is no bracketing total here
 *
 * The parser groups have one because a parse is a single nested operation whose
 * passes are its parts, so a remainder is meaningful. These rows are not parts
 * of a shared whole — a cache read and a worker's reply serialization are
 * unrelated operations on two different threads — so a "tier total" would be a
 * denominator for a share nobody should compute. The rows stand alone and are
 * read as absolute per-call costs.
 *
 * ## What each row is for
 *
 * The first three answer *what does the parent pay to use the cache*, split at
 * the one seam that matters: a MISS pays only the failed `readFile`, a HIT pays
 * that plus the decode. Averaging them into one `cache-read` would report a
 * per-document cost that describes neither.
 *
 * The rest answer *what does the parent pay to use a worker*. `wire-dispatch` is
 * the one `parse-pool.ts` has always named and never measured — "every document
 * crosses the boundary as a structured clone of its full content string, charged
 * to the PARENT thread, so it is serial". `wire-roundtrip` minus `worker-job` is
 * an UPPER BOUND on transit (serialize + queue + deserialize + scheduling), and
 * it is an upper bound rather than a measurement because a parent that is busy
 * when the reply lands charges its own delay to this row.
 *
 * 🪤 **Structured-clone DESERIALIZATION cannot be bracketed here and no row
 * claims to.** Node deserializes a message before it dispatches the `message`
 * event, so by the time any listener can read the clock the work is done. That
 * is why {@link TierPass.WireAttach} is scoped to `attachContent` alone and
 * named for it: a row called `wire-receive` would read as the whole receive
 * cost and silently under-report it. The consequence for an A/B is stated
 * rather than hidden — the wire arm's measured parent cost is a LOWER bound, so
 * "the wire arm looks cheaper" is not decidable from these rows alone, while
 * "the cache arm is cheaper" would be.
 */
export const TierPass = {
  /** The awaited `readFile` in `ParseCache.get` — charged on hit and miss alike. */
  CacheReadIo: 0,
  /** `JSON.parse` + schema validation + rehydrate. Charged on a HIT only. */
  CacheReadDecode: 1,
  /** The whole of `ParseCache.set`: stringify, `mkdir`, write, rename. */
  CacheWrite: 2,
  /** Parent-side `postMessage` of a parse request — the content clone. */
  WireDispatch: 3,
  /** Parent-side dispatch to reply-in-hand. See the upper-bound note above. */
  WireRoundtrip: 4,
  /** Parent-side `attachContent` ONLY. Deliberately not the deserialize. */
  WireAttach: 5,
  /** Worker-side: request received to reply posted. */
  WorkerJob: 6,
  /** Worker-side `postMessage` of the reply — the facts clone. */
  WorkerReply: 7,
} as const;

/** One of {@link TierPass}'s slot indices. */
export type TierPassSlot = (typeof TierPass)[keyof typeof TierPass];

/**
 * What each {@link TierPass} slot is called in the dump, positionally aligned.
 *
 * This array IS the dump's `tier` order — the contract a reader parses against.
 * `parse-timing.test.ts` pins the length against {@link TierPass} and pins every
 * name as disjoint from every parser pass name, so a tier row can never be
 * summed into a parser kind's denominator by a reader matching on name.
 */
export const TIER_PASS_NAMES: readonly string[] = [
  'cache-read-io',
  'cache-read-decode',
  'cache-write',
  'wire-dispatch',
  'wire-roundtrip',
  'wire-attach',
  'worker-job',
  'worker-reply',
];

/** How many slots {@link ParsePass} declares. */
const PASS_SLOT_COUNT = 15;

/**
 * What one parser kind contributes to the dump.
 *
 * The single declaration of a kind's identity: its name, its pass names in
 * pipeline order, where its slots live in the flat accumulator, and what its
 * bracketing total is called.
 */
export interface ParseKindShape {
  /** The kind's name in the dump. */
  readonly kind: string;
  /** Pass names in pipeline order, EXCLUDING the bracketing total. */
  readonly passNames: readonly string[];
  /** Slot of `passNames[0]`; the rest follow contiguously. */
  readonly firstPassSlot: number;
  /** Slot of the bracketing total. */
  readonly totalSlot: number;
  /** What the bracketing total is called in the dump. */
  readonly totalName: string;
}

/**
 * Every instrumented parser kind, positionally aligned with {@link ParserKind}.
 *
 * This array IS the dump's `kinds` order and each entry's `passNames` IS that
 * group's `passes` order — the contract a reader parses against. Do not reorder
 * either without versioning the dump.
 *
 * One entry per {@link ParserKind} slot, and `parse-timing.test.ts` pins both the
 * order and the LENGTH — an instrumented parser added to one and not the other
 * would otherwise be timed and never reported, or reported and never timed, with
 * every number in the dump still looking plausible.
 */
export const PARSE_KIND_SHAPES: readonly ParseKindShape[] = [
  {
    kind: 'markdown',
    passNames: [
      'estimate-tokens',
      'remark-processor',
      'remark-parse',
      'micromark-tokenize',
      'ast-facts',
      'unresolved-references',
      'code-context-ranges',
      'lexical-references',
      'measure-content',
    ],
    firstPassSlot: ParsePass.EstimateTokens,
    totalSlot: ParsePass.MarkdownTotal,
    totalName: 'markdown-total',
  },
  {
    kind: 'html',
    // parse5 and the element walk are the two passes with no markdown
    // counterpart; the other two are the same operations markdown runs, and
    // deliberately share their names so the two kinds can be read side by side.
    passNames: ['parse5-parse', 'element-walk', 'estimate-tokens', 'measure-content'],
    firstPassSlot: ParsePass.HtmlParse,
    totalSlot: ParsePass.HtmlTotal,
    totalName: 'html-total',
  },
];

/** One row of a kind group's `passes`, or its `total`. */
export interface ParseTimingPass {
  pass: string;
  calls: number;
  elapsedMs: number;
}

/** One parser kind's group in the dump. */
export interface ParseTimingKind {
  /** The parser kind — `markdown`, `html`. */
  kind: string;
  /** Documents this parser ran over, and the bytes attributed to them. */
  documents: { count: number; bytes: number };
  /**
   * The bracket around the whole parse, kept OUT of `passes` on purpose.
   *
   * See the module docstring: no arrangement of the rows a reader is given may
   * let them compute a remainder against the wrong bracket.
   */
  total: ParseTimingPass;
  /** The attributed passes, in pipeline order, always all of them. */
  passes: ParseTimingPass[];
}

/**
 * Process-level wall and CPU time, read ONCE when the dump is written.
 *
 * All three are lifetime figures for the whole process, not for the parse: the
 * point of carrying them is the *ratio*. CPU well below wall means the process
 * was waiting rather than computing, and the per-pass wall numbers are
 * correspondingly less trustworthy. CPU above wall is normal and not an error —
 * `process.cpuUsage()` sums every thread, including libuv's pool.
 */
export type ParseTimingProcess = TimingProcess;

/**
 * What ONE thread accumulated — every counter in this module that is a thread's
 * own rather than the process's.
 *
 * ## Why a pid was never enough
 *
 * Worker threads share their parent's pid, so `pid` alone cannot distinguish
 * eight worker threads from eight phase processes. That distinction is not
 * cosmetic for the tier rows. Every one of them is a cost, and the only question
 * that matters about a cost in this design is whether it lands on the SERIAL
 * parent or on a parallel worker: the same `cache-write` milliseconds are a
 * bottleneck in one place and nearly free in the other. A merge that summed both
 * would report an identical figure for two arrangements the tier exists to
 * choose between.
 *
 * ⭐ These counters travel to the main thread over the parse pool's own message
 * channel and are written out by ONE writer — see {@link ParseTimingDump}.
 */
export interface ParseThreadTiming {
  /** `0` on the main thread, a positive integer in a parse worker. */
  threadId: number;
  /** Parse-cache outcomes across EVERY parser kind, on this thread. */
  cache: { hits: number; misses: number };
  /** One group per instrumented parser kind, always all of them. */
  kinds: ParseTimingKind[];
  /**
   * Work the parse tier did AROUND the parses, in {@link TIER_PASS_NAMES} order.
   *
   * Beside `kinds` and never inside it — see {@link TierPass} for why that
   * placement is the whole point, and for what each row does and does not
   * measure. Always every row, even at zero.
   */
  tier: ParseTimingPass[];
}

/**
 * The on-disk dump shape: ONE file per PROCESS, carrying every thread of it.
 *
 * ## Why the process writes once instead of every thread writing for itself
 *
 * Each worker thread has its own module instance of this file and its own
 * accumulators. It hands them back as a {@link ParseThreadTiming} over the parse
 * pool's existing message channel when it is asked to shut down; the main thread
 * collects them and writes this file. One writer buys three things, and none of
 * them is cosmetic:
 *
 * - **The counters do not depend on an exit listener having run.** A thread
 *   closed with `terminate()` never runs its exit listeners, and a process
 *   exiting with live threads does not run theirs either — so anything a thread
 *   only writes at its own exit is conditional on a graceful close it does not
 *   control.
 * - **There is no filename to race for.** N writers in one process would need a
 *   collision counter to avoid overwriting each other's file.
 * - ⭐ **The thread structure is DATA, not an inference from a file count.**
 *   `process.uptime()` and `process.cpuUsage()` are the PROCESS's, so N files
 *   would each report the same whole-process lifetime; a reader summing them
 *   multiplies one lifetime by the pool's width, and the result reads as a
 *   performance regression of exactly that factor. Read once, by the one thread
 *   that can meaningfully read it, there is no such sum to make.
 *
 * ⚠️ **There is no version field, and adding one back is a defect.** A reader
 * refuses an unknown layout by validating against its own strict schema, which
 * moves the instant a field here is added, renamed or retyped — where an integer
 * moved only when a human remembered. `lab`'s `harness/dumps.ts` is the reading
 * side; a dump this build cannot model is named and refused there.
 */
export interface ParseTimingDump {
  pid: number;
  /** See {@link ParseTimingProcess}. Lifetime figures, not parse durations. */
  process: ParseTimingProcess;
  /**
   * Every thread of this process that accumulated anything, main thread FIRST.
   *
   * Always carries the main thread, even when it parsed nothing: it is the
   * denominator for every "what did the serial thread pay" question, and an
   * absent group and a zero one must never have to be told apart.
   *
   * A worker is here only if it answered the shutdown request. One that was
   * `terminate()`d without answering is absent, and absent VISIBLY: a reader
   * comparing this count against the pool's width can see that a thread's work
   * is unaccounted for.
   */
  threads: ParseThreadTiming[];
}

/** Basename stem of a dump file; the pid (and any collision counter) follow. */
const DUMP_BASENAME = 'parse-timing';

/** What this seam is called in a failure line. */
const DUMP_NOUN = 'parse-timing';

const passElapsedMs = new Float64Array(PASS_SLOT_COUNT);
const passCalls = new Float64Array(PASS_SLOT_COUNT);

/**
 * Tier accumulators, in their OWN arrays rather than appended to the flat parser
 * slot space.
 *
 * Separate arrays are what make it structurally impossible for a tier slot to
 * leak into a kind group: {@link kindGroup} reads `passElapsedMs` by a slot it
 * derives from {@link PARSE_KIND_SHAPES}, and there is no index it could compute
 * that reaches these. Appending to the flat array would have kept the hot path
 * identical and left that safety to arithmetic.
 */
const tierElapsedMs = new Float64Array(TIER_PASS_NAMES.length);
const tierCalls = new Float64Array(TIER_PASS_NAMES.length);

const documentCounts = new Float64Array(PARSE_KIND_SHAPES.length);
const documentBytes = new Float64Array(PARSE_KIND_SHAPES.length);

let cacheHits = 0;
let cacheMisses = 0;

/**
 * Counters other threads of this process have handed over, in arrival order.
 *
 * Only ever non-empty on the main thread: a worker reports to the parent, never
 * the other way round, and {@link recordThreadTiming} is what the parse pool
 * calls when a shutting-down worker answers. Held rather than merged, because
 * the whole point of the shape is that the reader can still see which thread
 * paid for what — see {@link ParseThreadTiming}.
 */
const reportedThreads: ParseThreadTiming[] = [];

/**
 * Where dumps go, or `null` when the seam is off.
 *
 * Read ONCE, here, from `process.env`. See the module docstring for why this
 * deliberately differs from `parse-cache.ts`'s per-construction rule.
 */
let dumpDirectory: string | null = normalizeTimingDirectory(process.env['VAT_PARSE_TIMING']);

/**
 * The hot path's gate. A plain boolean rather than `dumpDirectory !== null` so
 * every instrumented call site costs one predictable branch on a memory load.
 */
let timingEnabled = dumpDirectory !== null;

/**
 * One pass row, read out of the flat accumulators.
 *
 * @param pass - The name this slot carries in the dump
 * @param slot - Which accumulator slot to read
 * @returns The row
 */
function passRow(pass: string, slot: number): ParseTimingPass {
  return { pass, calls: passCalls[slot] ?? 0, elapsedMs: passElapsedMs[slot] ?? 0 };
}

/**
 * One parser kind's group, read out of the accumulators.
 *
 * @param shape - The kind's declaration
 * @param index - Its slot in the document counters
 * @returns The group, with every pass present even at zero
 */
function kindGroup(shape: ParseKindShape, index: number): ParseTimingKind {
  return {
    kind: shape.kind,
    documents: { count: documentCounts[index] ?? 0, bytes: documentBytes[index] ?? 0 },
    total: passRow(shape.totalName, shape.totalSlot),
    passes: shape.passNames.map((name, offset) => passRow(name, shape.firstPassSlot + offset)),
  };
}

/**
 * Build THIS thread's counters.
 *
 * Always emits every kind, and within each every pass, in declared order — so a
 * reader never has to distinguish an absent group or pass from a zero one.
 *
 * The one function that assembles a thread's record, whether the thread is the
 * main one snapshotting itself or a worker answering a shutdown request. Two
 * assembly sites for one published shape is a defect class this codebase has
 * already paid for, so there is deliberately only one.
 *
 * @returns A snapshot of every counter this thread owns
 */
function buildThreadTiming(): ParseThreadTiming {
  return {
    threadId,
    cache: { hits: cacheHits, misses: cacheMisses },
    kinds: PARSE_KIND_SHAPES.map((shape, index) => kindGroup(shape, index)),
    tier: TIER_PASS_NAMES.map((name, slot) => ({
      pass: name,
      calls: tierCalls[slot] ?? 0,
      elapsedMs: tierElapsedMs[slot] ?? 0,
    })),
  };
}

/**
 * Build the dump from this process's state: its lifetime, its own thread, and
 * every worker thread that has reported in.
 *
 * The main thread's record is always FIRST, and always present even at zero —
 * see {@link ParseTimingDump.threads}.
 *
 * @returns The whole process's dump
 */
function buildDump(): ParseTimingDump {
  return {
    pid: process.pid,
    process: readTimingProcess(),
    threads: [buildThreadTiming(), ...reportedThreads],
  };
}

/**
 * Write the dump, if the seam is on.
 *
 * A write failure is reported on stderr and NEVER thrown — this runs from an
 * `exit` listener, where a throw would change the process's exit behaviour.
 *
 * @returns The path written, or `null` when the seam is off or the write failed
 */
function writeDump(): string | null {
  return writeTimingDump(DUMP_NOUN, dumpDirectory, DUMP_BASENAME, buildDump);
}

/**
 * Zero every accumulator.
 *
 * The process wall/CPU readings are NOT here: they are lifetime figures taken
 * fresh at dump time, so there is nothing of theirs to zero.
 */
function resetAccumulators(): void {
  passElapsedMs.fill(0);
  passCalls.fill(0);
  tierElapsedMs.fill(0);
  tierCalls.fill(0);
  documentCounts.fill(0);
  documentBytes.fill(0);
  cacheHits = 0;
  cacheMisses = 0;
  reportedThreads.length = 0;
}

if (dumpDirectory !== null) {
  ensureTimingDirectory(DUMP_NOUN, dumpDirectory);
  // Registered ONLY when enabled, and ONLY on the main thread: this process
  // writes exactly one dump, carrying every thread. A worker registering this
  // listener would file a second, partial file reporting the same whole-process
  // lifetime — see `ParseTimingDump`. Its counters travel over the pool's
  // channel instead.
  if (isMainThread) {
    process.on('exit', () => {
      writeDump();
    });
  }
}

/**
 * Start a pass timer.
 *
 * @returns `performance.now()` when the seam is on, `0` when it is off
 */
export function parseTimingStart(): number {
  return timingEnabled ? performance.now() : 0;
}

/**
 * Attribute elapsed time to a pass.
 *
 * @param pass - Which slot to charge
 * @param startedAt - The value {@link parseTimingStart} returned
 */
export function recordParsePass(pass: ParsePassSlot, startedAt: number): void {
  if (!timingEnabled) return;
  const elapsed = performance.now() - startedAt;
  passElapsedMs[pass] = (passElapsedMs[pass] ?? 0) + elapsed;
  passCalls[pass] = (passCalls[pass] ?? 0) + 1;
}

/**
 * Attribute elapsed time to a tier pass.
 *
 * Same gate and the same two `performance.now()` reads as {@link recordParsePass}
 * — a separate function only because the slot spaces are separate arrays, which
 * is what keeps tier work out of every parser kind group (see {@link TierPass}).
 *
 * @param pass - Which tier slot to charge
 * @param startedAt - The value {@link parseTimingStart} returned
 */
export function recordTierPass(pass: TierPassSlot, startedAt: number): void {
  if (!timingEnabled) return;
  const elapsed = performance.now() - startedAt;
  tierElapsedMs[pass] = (tierElapsedMs[pass] ?? 0) + elapsed;
  tierCalls[pass] = (tierCalls[pass] ?? 0) + 1;
}

/**
 * Count one document a parser actually ran over.
 *
 * @param kind - Which parser ran
 * @param bytes - Byte size attributed to the document
 */
export function recordParsedDocument(kind: ParserKindSlot, bytes: number): void {
  if (!timingEnabled) return;
  documentCounts[kind] = (documentCounts[kind] ?? 0) + 1;
  documentBytes[kind] = (documentBytes[kind] ?? 0) + bytes;
}

/**
 * This thread's counters, for handing to the thread that writes the dump.
 *
 * Called in a parse worker when the pool asks it to shut down — the moment its
 * counters become final, because it has no job left. Handing them over at that
 * moment is what makes them independent of whether this thread's exit listeners
 * ever run, which a thread being `terminate()`d does not get to decide.
 *
 * @returns This thread's record, or `null` when the seam is off
 */
export function readThreadTiming(): ParseThreadTiming | null {
  return timingEnabled ? buildThreadTiming() : null;
}

/**
 * Take another thread's counters into this process's dump.
 *
 * A no-op when the seam is off here: this process writes no dump, so there is
 * nowhere for the record to go and holding it would be a leak. Note that the
 * two gates are independent — a worker reads `VAT_PARSE_TIMING` from the env it
 * was constructed with, so a test can have an instrumented worker report to an
 * uninstrumented parent, and the record is dropped rather than half-kept.
 *
 * @param thread - What {@link readThreadTiming} produced on the other thread
 */
export function recordThreadTiming(thread: ParseThreadTiming): void {
  if (!timingEnabled) return;
  reportedThreads.push(thread);
}

/** Count one parse-cache hit — a document the parser did NOT have to run over. */
export function recordParseCacheHit(): void {
  if (!timingEnabled) return;
  cacheHits += 1;
}

/** Count one parse-cache miss — a document that reached a parser. */
export function recordParseCacheMiss(): void {
  if (!timingEnabled) return;
  cacheMisses += 1;
}

/**
 * TEST ONLY. Turn the seam on (writing to `directory`) or off, and zero every
 * accumulator.
 *
 * This exists so tests never have to mutate the real `process.env` — which they
 * could not usefully do anyway, since the gate is read once at module load and
 * `vitest.setup.js` deletes every `VAT_*` variable first. It deliberately does
 * NOT register an `exit` listener; a test drives the write itself via
 * {@link __writeParseTimingDumpForTest}, so a test run never litters dumps.
 *
 * @param directory - Where {@link __writeParseTimingDumpForTest} writes, or `null` to disable
 */
export function __setParseTimingForTest(directory: string | null): void {
  dumpDirectory = normalizeTimingDirectory(directory ?? undefined);
  timingEnabled = dumpDirectory !== null;
  resetAccumulators();
  if (dumpDirectory !== null) ensureTimingDirectory(DUMP_NOUN, dumpDirectory);
}

/**
 * TEST ONLY. Read this thread's accumulators without writing anything.
 *
 * Scoped to the THREAD rather than the whole dump because the accumulators are
 * what a unit test is asserting about: the process figures are a clock reading
 * with nothing to assert, and the other threads' records are whatever
 * {@link recordThreadTiming} was handed. A test that wants the assembled file
 * asks {@link __writeParseTimingDumpForTest} for one and reads it back.
 *
 * @returns This thread's counters as they stand
 */
export function __readParseTimingSnapshot(): ParseThreadTiming {
  return buildThreadTiming();
}

/**
 * TEST ONLY. Write a dump now, exactly as the exit listener would.
 *
 * @returns The path written, or `null` when the seam is off or the write failed
 */
export function __writeParseTimingDumpForTest(): string | null {
  return writeDump();
}
