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

import { existsSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';

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
  AstFacts: 3,
  UnresolvedReferences: 4,
  CodeContextRanges: 5,
  LexicalReferences: 6,
  MeasureContent: 7,
  /** Brackets the whole markdown parse. Always last in its group. */
  MarkdownTotal: 8,

  // HTML — `parseHtmlContent` in html-link-parser.ts.
  HtmlParse: 9,
  HtmlElementWalk: 10,
  HtmlEstimateTokens: 11,
  HtmlMeasureContent: 12,
  /** Brackets the whole HTML parse. Always last in its group. */
  HtmlTotal: 13,
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
 */
export const ParserKind = {
  Markdown: 0,
  Html: 1,
} as const;

/** One of {@link ParserKind}'s slot indices. */
export type ParserKindSlot = (typeof ParserKind)[keyof typeof ParserKind];

/** How many slots {@link ParsePass} declares. */
const PASS_SLOT_COUNT = 14;

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
 */
export const PARSE_KIND_SHAPES: readonly ParseKindShape[] = [
  {
    kind: 'markdown',
    passNames: [
      'estimate-tokens',
      'remark-processor',
      'remark-parse',
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
export interface ParseTimingProcess {
  /** Wall clock since this process started. */
  wallMs: number;
  /** User CPU consumed by the process, across all its threads. */
  cpuUserMs: number;
  /** System CPU consumed by the process, across all its threads. */
  cpuSystemMs: number;
}

/** The on-disk dump shape. Versioned so a reader can refuse an unknown layout. */
export interface ParseTimingDump {
  dumpVersion: number;
  pid: number;
  /** See {@link ParseTimingProcess}. Lifetime figures, not parse durations. */
  process: ParseTimingProcess;
  /** Parse-cache outcomes across EVERY parser kind. */
  cache: { hits: number; misses: number };
  /** One group per instrumented parser kind, always all of them. */
  kinds: ParseTimingKind[];
}

/**
 * Bumped whenever the dump layout changes in a way a reader must notice.
 *
 * 2 — HTML became a first-class instrumented kind: `documents` and `passes` are
 * grouped per parser kind with a per-kind total (`markdown-total`, `html-total`,
 * replacing the bare `total` that silently meant markdown), and the dump gained
 * process wall/CPU time.
 */
const DUMP_VERSION = 2;

/** `process.cpuUsage()` reports microseconds; the dump reports milliseconds. */
const MICROSECONDS_PER_MS = 1000;

/** `process.uptime()` reports seconds; the dump reports milliseconds. */
const MS_PER_SECOND = 1000;

/** Basename stem of a dump file; the pid (and any collision counter) follow. */
const DUMP_BASENAME = 'parse-timing';

/**
 * Ceiling on the pid-collision search. A directory holding this many dumps for
 * one pid is a runaway, not a collision; overwriting the last slot is a better
 * outcome than spinning.
 */
const MAX_DUMP_COLLISIONS = 1000;

const passElapsedMs = new Float64Array(PASS_SLOT_COUNT);
const passCalls = new Float64Array(PASS_SLOT_COUNT);

const documentCounts = new Float64Array(PARSE_KIND_SHAPES.length);
const documentBytes = new Float64Array(PARSE_KIND_SHAPES.length);

let cacheHits = 0;
let cacheMisses = 0;

/**
 * Where dumps go, or `null` when the seam is off.
 *
 * Read ONCE, here, from `process.env`. See the module docstring for why this
 * deliberately differs from `parse-cache.ts`'s per-construction rule.
 */
let dumpDirectory: string | null = normalizeDumpDirectory(process.env['VAT_PARSE_TIMING']);

/**
 * The hot path's gate. A plain boolean rather than `dumpDirectory !== null` so
 * every instrumented call site costs one predictable branch on a memory load.
 */
let timingEnabled = dumpDirectory !== null;

/**
 * Reduce a raw env value to a directory or `null`.
 *
 * @param raw - The env var's value, if set
 * @returns The dump directory, or `null` when the seam is off
 */
function normalizeDumpDirectory(raw: string | undefined): string | null {
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Create the dump directory, swallowing failure.
 *
 * Done once when the seam turns on rather than at exit, so a bad path is
 * reported while there is still a run to abandon — and so the exit handler does
 * the minimum possible work.
 *
 * @param directory - Directory dumps will be written to
 */
function ensureDumpDirectory(directory: string): void {
  try {
    mkdirSyncReal(directory, { recursive: true });
  } catch (error) {
    reportDumpFailure(directory, error);
  }
}

/**
 * Report a dump problem on stderr.
 *
 * Never throws and never touches stdout: vat's stdout carries a YAML report,
 * and an exit handler that throws would change the process's exit behaviour.
 *
 * @param target - Path the failure concerns
 * @param error - Whatever was caught
 */
function reportDumpFailure(target: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vat: parse-timing dump failed for ${target}: ${detail}\n`);
}

/**
 * Pick a dump path that does not already exist.
 *
 * Pids are reused across a long multi-phase run (`vat validate` spawns the vat
 * binary once per phase), so `parse-timing-<pid>.json` genuinely collides. An
 * increasing counter is appended until the name is free.
 *
 * @param directory - Directory dumps are written to
 * @returns An unused path, or the last candidate tried
 */
function nextDumpPath(directory: string): string {
  const stem = `${DUMP_BASENAME}-${String(process.pid)}`;
  let candidate = safePath.join(directory, `${stem}.json`);
  for (
    let collision = 1;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied diagnostic directory from VAT_PARSE_TIMING
    collision <= MAX_DUMP_COLLISIONS && existsSync(candidate);
    collision += 1
  ) {
    candidate = safePath.join(directory, `${stem}-${String(collision)}.json`);
  }
  return candidate;
}

/**
 * Read this process's lifetime wall and CPU time.
 *
 * Called ONCE, from {@link buildDump} — two syscalls for the whole run, which is
 * why the process level can afford a CPU reading the per-pass level cannot.
 * Deliberately not an accumulator and deliberately not reset: it describes the
 * process, not the measurement window.
 *
 * @returns Wall clock and CPU since process start, in milliseconds
 */
function readProcessTime(): ParseTimingProcess {
  const cpu = process.cpuUsage();
  return {
    wallMs: process.uptime() * MS_PER_SECOND,
    cpuUserMs: cpu.user / MICROSECONDS_PER_MS,
    cpuSystemMs: cpu.system / MICROSECONDS_PER_MS,
  };
}

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
 * Build the dump from the current accumulator state.
 *
 * Always emits every kind, and within each every pass, in declared order — so a
 * reader never has to distinguish an absent group or pass from a zero one.
 *
 * @returns A snapshot of every counter
 */
function buildDump(): ParseTimingDump {
  return {
    dumpVersion: DUMP_VERSION,
    pid: process.pid,
    process: readProcessTime(),
    cache: { hits: cacheHits, misses: cacheMisses },
    kinds: PARSE_KIND_SHAPES.map((shape, index) => kindGroup(shape, index)),
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
  if (dumpDirectory === null) return null;

  const target = nextDumpPath(dumpDirectory);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied diagnostic directory from VAT_PARSE_TIMING
    writeFileSync(target, `${JSON.stringify(buildDump(), null, 2)}\n`, 'utf-8');
  } catch (error) {
    reportDumpFailure(target, error);
    return null;
  }
  return target;
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
  documentCounts.fill(0);
  documentBytes.fill(0);
  cacheHits = 0;
  cacheMisses = 0;
}

if (dumpDirectory !== null) {
  ensureDumpDirectory(dumpDirectory);
  // Registered ONLY when enabled: a disabled seam must not even add a listener.
  process.on('exit', () => {
    writeDump();
  });
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
  dumpDirectory = normalizeDumpDirectory(directory ?? undefined);
  timingEnabled = dumpDirectory !== null;
  resetAccumulators();
  if (dumpDirectory !== null) ensureDumpDirectory(dumpDirectory);
}

/**
 * TEST ONLY. Read the accumulators without writing anything.
 *
 * @returns The dump that would be written right now
 */
export function __readParseTimingSnapshot(): ParseTimingDump {
  return buildDump();
}

/**
 * TEST ONLY. Write a dump now, exactly as the exit listener would.
 *
 * @returns The path written, or `null` when the seam is off or the write failed
 */
export function __writeParseTimingDumpForTest(): string | null {
  return writeDump();
}
