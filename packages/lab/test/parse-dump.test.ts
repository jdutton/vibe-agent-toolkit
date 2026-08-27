/**
 * The `parse` facet's dump reader.
 *
 * Four of these tests are the reason the file exists, and every one of them
 * guards against a *confident wrong number* rather than a crash:
 *
 * 1. **The env-var literal is pinned.** `VAT_PARSE_TIMING` is the whole contract
 *    with a vat that was built separately, and the lab deliberately does not
 *    import it from `@vibe-agent-toolkit/resources` — an A/B arm may be a build
 *    that has no seam at all, so the facet has to compile against, and refuse
 *    cleanly for, a vat that has never heard of it. That decision only holds if
 *    something pins the spelling, exactly as `io-counter.test.ts` pins
 *    `VAT_LAB_IO_LOG`.
 * 2. **Merging across PIDs.** One vat invocation spawns a child per phase, so a
 *    reader that took the first file it found would report one phase's timings
 *    and look perfectly healthy doing it. The fixtures give the two PIDs
 *    *different* numbers, so a first-file reader, a last-file reader and a
 *    merging reader all produce visibly different answers.
 * 3. **An empty directory is a refusal, not a zero.** No dump means the build
 *    has no seam. "Parsing took 0 ms" is a perfectly plausible-looking lie.
 * 4. **The three zero-states stay distinguishable.** A warm cache, an
 *    uninstrumented parser, and a command that never parsed at all produce the
 *    identical `documents: 0` and must not be reported identically.
 * 5. **Each parser kind brackets itself.** Every kind carries its own total,
 *    beside its rows rather than among them, so no sum of the rows a reader is
 *    given can produce a remainder against the wrong bracket — and one kind's
 *    passes can never be charged to another's denominator.
 * 6. **One process observed N times is not N processes.** vat's parse worker
 *    threads share their parent's pid and each writes its own dump carrying the
 *    WHOLE PROCESS's lifetime, so summing those lifetimes multiplies wall and
 *    CPU by the thread count. Measured: 9 dumps, 1 pid, 104,111ms reported
 *    against ~11,568ms of real wall clock — read as a 6.5x regression, which is
 *    why the pool shipped disabled. What each thread measured for ITSELF still
 *    sums, and the fixtures below distinguish the two halves rather than
 *    treating "same pid" as a licence to drop rows.
 *
 * `documents === cache.misses` is deliberately **never** asserted, and no
 * fixture is built assuming it: several call sites reach a parser without
 * consulting the cache at all, so the parse counts can exceed the misses, and
 * the difference is published as a labelled remainder instead.
 */

import { mkdtemp } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  attributionOf,
  type MergedParseDumps,
  type MergedParseKind,
  type TierPassStats,
  mergeParseDumps,
  PARSE_TIMING_DIR_ENV,
  type ParseDump,
  type ParseDumpKind,
  type ParseDumpPass,
  type ParseDumpProcess,
  type ParseThreadDump,
  parseTotalName,
  readParseDumps,
  sameParseWork,
} from '../src/facets/parse/dump.js';
import { ParseBodySchema } from '../src/facets/parse/types.js';

import { writeDumpDir } from './dump-fixtures.js';
import { parseBody, parseCommand } from './parse-fixtures.js';

/** Fixture constants, named so the same string never appears twice. */
const LEXER = 'remark-parse';
const REFERENCES = 'lexical-references';
const MARKDOWN = 'markdown';
const HTML = 'html';
const HTML_PARSE = 'parse5-parse';
const FUTURE_KIND = 'a-parser-from-the-future';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-parse-dump-'));
});

/**
 * One parser kind's group, with its total named after it.
 *
 * @param kind - The parser kind
 * @param documents - Documents and bytes it parsed
 * @param totalMs - Its bracketing total's elapsed time
 * @param passes - Its attributed passes
 * @returns A complete group
 */
function kindGroup(
  kind: string,
  documents: { count: number; bytes: number },
  totalMs: number,
  passes: readonly ParseDumpPass[],
): ParseDumpKind {
  return {
    kind,
    documents,
    total: { pass: parseTotalName(kind), calls: documents.count, elapsedMs: totalMs },
    passes,
  };
}

/** The markdown group every default fixture carries. */
function markdownGroup(): ParseDumpKind {
  return kindGroup(MARKDOWN, { count: 10, bytes: 1000 }, 60, [
    { pass: LEXER, calls: 10, elapsedMs: 40 },
    { pass: REFERENCES, calls: 10, elapsedMs: 10 },
  ]);
}

/** An HTML group that parsed nothing — the shipped shape on a markdown-only tree. */
function emptyHtmlGroup(): ParseDumpKind {
  return kindGroup(HTML, { count: 0, bytes: 0 }, 0, [{ pass: HTML_PARSE, calls: 0, elapsedMs: 0 }]);
}

/** What a process reports for itself unless the case varies it. */
const DEFAULT_LIFETIME: ParseDumpProcess = { wallMs: 2000, cpuUserMs: 1500, cpuSystemMs: 300 };

/**
 * Build one thread's record without repeating the defaults in every fixture.
 *
 * @param over - What the case varies
 * @returns A complete thread record
 */
function thread(over: Partial<ParseThreadDump> = {}): ParseThreadDump {
  return {
    // A main thread unless the case says otherwise: the default fixture is a
    // single-threaded run, and a case about worker threads sets this explicitly
    // rather than inheriting a thread id it did not choose.
    threadId: 0,
    cache: { hits: 0, misses: 10 },
    kinds: [markdownGroup(), emptyHtmlGroup()],
    tier: [],
    ...over,
  };
}

/**
 * A single-threaded process: one main thread and nothing else.
 *
 * @param pid - Which process wrote it
 * @param over - What the case varies, thread fields and `process` alike
 * @returns A complete dump
 */
function dump(
  pid: number,
  over: Partial<ParseThreadDump> & { process?: ParseDumpProcess } = {},
): ParseDump {
  const { process: lifetime, ...threadOver } = over;
  return { pid, process: lifetime ?? DEFAULT_LIFETIME, threads: [thread(threadOver)] };
}

/**
 * A process running a parse pool: one main thread and N workers, in ONE dump.
 *
 * The shape that makes this facet's summing rules legible — the lifetime is the
 * process's and appears once, while everything the threads measured for
 * themselves is disjoint and adds.
 *
 * @param pid - Which process wrote it
 * @param threads - Each thread's record, main thread first by convention
 * @returns A complete dump
 */
function pooled(pid: number, ...threads: readonly Partial<ParseThreadDump>[]): ParseDump {
  return { pid, process: DEFAULT_LIFETIME, threads: threads.map((one) => thread(one)) };
}

/**
 * A dump whose markdown passes are given explicitly.
 *
 * @param pid - Which process wrote it
 * @param passes - The markdown group's pass rows
 * @param totalMs - The markdown group's total
 * @returns A complete dump
 */
function dumpWithPasses(pid: number, passes: readonly ParseDumpPass[], totalMs = 60): ParseDump {
  return dump(pid, {
    kinds: [kindGroup(MARKDOWN, { count: 10, bytes: 1000 }, totalMs, passes)],
  });
}

/**
 * One kind out of a merge, failing loudly when it is absent.
 *
 * @param merged - The merged numbers
 * @param kind - Which kind to read
 * @returns That kind's merged numbers
 */
function kindOf(merged: MergedParseDumps, kind: string): MergedParseKind {
  const found = merged.kinds.find((one) => one.kind === kind);
  if (found === undefined) throw new Error(`merge carries no '${kind}' kind`);
  return found;
}

/**
 * Write raw files into a fresh directory under this suite's temp root.
 *
 * @param name - Temp directory label
 * @param files - Raw file contents to write, verbatim
 * @returns The directory
 */
async function dumpDir(name: string, files: Readonly<Record<string, string>>): Promise<string> {
  return writeDumpDir(tempDir, name, files);
}

/**
 * Assert that a directory of raw dump text is refused, and why.
 *
 * @param name - Temp directory label
 * @param files - Raw file contents to write, verbatim
 * @param pattern - What the refusal message must say
 */
async function expectRefusal(
  name: string,
  files: Record<string, string>,
  pattern: RegExp,
): Promise<void> {
  const directory = await dumpDir(name, files);
  const result = await readParseDumps(directory);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.refusal).toMatch(pattern);
}

/**
 * Read a directory of well-formed dumps, failing loudly if it refused.
 *
 * @param name - Directory name under the temp root
 * @param dumps - The dumps to write into it
 * @returns The merged numbers
 * @throws When the read refused, which no caller of this helper expects
 */
async function expectMerge(name: string, dumps: readonly ParseDump[]): Promise<MergedParseDumps> {
  const files: Record<string, string> = {};
  for (const one of dumps) files[`parse-timing-${String(one.pid)}.json`] = JSON.stringify(one);
  const result = await readParseDumps(await dumpDir(name, files));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.refusal);
  return result.merged;
}

describe('the contract with the seam', () => {
  it('pins the env var the seam activates on', () => {
    // The lab declares this literal rather than importing it, because an A/B arm
    // may be a vat build that predates the seam entirely — see the module header.
    // If the two sides ever disagree, every capture silently produces no dumps
    // and every row refuses; this assertion is the only thing that would notice.
    expect(PARSE_TIMING_DIR_ENV).toBe('VAT_PARSE_TIMING');
  });

  it('pins how a kind names its own bracketing total', () => {
    // A kind's total is the denominator of every share in its group and the
    // minuend of its remainder. It is named after the kind rather than being a
    // bare `total`, so no group's bracket can be mistaken for "the" total — the
    // way a single markdown-only `total` silently was on a tree that is mostly
    // something else. A rename on either side must be a version bump, not a
    // silently empty breakdown.
    expect(parseTotalName(MARKDOWN)).toBe('markdown-total');
    expect(parseTotalName(HTML)).toBe('html-total');
  });
});

describe('mergeParseDumps', () => {
  /**
   * Two processes reporting the same passes with DIFFERENT numbers.
   *
   * The asymmetry is the point: a reader that took only the first dump gets 60,
   * only the last gets 20, and a merging reader gets 80 — three visibly
   * different answers, so the fixture can distinguish them. Equal values could
   * not.
   *
   * @returns The merge of the two
   */
  const twoProcesses = (): MergedParseDumps =>
    mergeParseDumps([
      dump(1),
      dump(2, {
        cache: { hits: 3, misses: 4 },
        kinds: [
          kindGroup(MARKDOWN, { count: 4, bytes: 400 }, 20, [
            { pass: LEXER, calls: 4, elapsedMs: 12 },
            { pass: REFERENCES, calls: 4, elapsedMs: 3 },
          ]),
        ],
      }),
    ]);

  it('sums documents, bytes and the cache split across processes', () => {
    const merged = twoProcesses();
    expect(merged.processes).toBe(2);
    expect(merged.documents).toBe(14);
    expect(merged.bytes).toBe(1400);
    expect(merged.cacheHits).toBe(3);
    expect(merged.cacheMisses).toBe(14);
  });

  it('sums each pass across processes and keeps each total out of its list', () => {
    const markdown = kindOf(twoProcesses(), MARKDOWN);
    expect(markdown.total.elapsedMs).toBe(80);
    expect(markdown.total.calls).toBe(14);
    // A kind's total brackets its whole parse, so leaving it among that kind's
    // passes would double every sum taken over them.
    expect(markdown.passes.map((pass) => pass.pass)).toEqual([LEXER, REFERENCES]);
    expect(markdown.passes.map((pass) => pass.elapsedMs)).toEqual([52, 13]);
  });

  it('keeps each kind apart, with its own documents and its own bracket', () => {
    // The regression this whole shape exists for: a merge that pooled the kinds
    // would report one breakdown over 14 documents and no way to see that one
    // parser did almost all the work.
    const merged = mergeParseDumps([
      dump(1, {
        cache: { hits: 0, misses: 24 },
        kinds: [
          markdownGroup(),
          kindGroup(HTML, { count: 14, bytes: 9000 }, 300, [
            { pass: HTML_PARSE, calls: 14, elapsedMs: 220 },
            { pass: 'element-walk', calls: 14, elapsedMs: 60 },
          ]),
        ],
      }),
    ]);

    expect(merged.kinds.map((kind) => kind.kind)).toEqual([MARKDOWN, HTML]);
    expect(kindOf(merged, MARKDOWN).documents).toBe(10);
    expect(kindOf(merged, HTML).documents).toBe(14);
    expect(kindOf(merged, MARKDOWN).total.elapsedMs).toBe(60);
    expect(kindOf(merged, HTML).total.elapsedMs).toBe(300);
    // And the command-wide figures are the sums of those, not one kind's.
    expect(merged.documents).toBe(24);
    expect(merged.totalMs).toBe(360);
  });

  it('reports the remainder nothing accounted for, per kind and overall', () => {
    // 80 total, 65 attributed for markdown. The number that says the breakdown
    // above it is incomplete — and the one the facet exists to publish.
    const merged = twoProcesses();
    expect(kindOf(merged, MARKDOWN).unattributedMs).toBe(15);
    // The empty HTML group contributes nothing, so the command-wide remainder
    // is the markdown one and no arithmetic crossed a bracket to get there.
    expect(merged.unattributedMs).toBe(15);
  });

  it('names the parses that never consulted the cache, as a remainder', () => {
    // 14 documents against 4 misses: ten parses reached a parser by a route that
    // never touches the cache. Not an invariant, and never asserted as one.
    const merged = mergeParseDumps([
      dump(1, { cache: { hits: 0, misses: 4 } }),
      dump(2, { cache: { hits: 0, misses: 0 } }),
    ]);
    expect(merged.documents).toBe(20);
    expect(merged.uncachedParses).toBe(16);
  });

  it('keeps pass order from first appearance, not from cost', () => {
    // Pipeline order is stable between reports; a sort by elapsed time would
    // reorder the report every time the numbers moved.
    const merged = mergeParseDumps([
      dumpWithPasses(
        1,
        [
          { pass: 'estimate-tokens', calls: 1, elapsedMs: 1 },
          { pass: LEXER, calls: 1, elapsedMs: 90 },
        ],
        100,
      ),
    ]);
    expect(kindOf(merged, MARKDOWN).passes.map((pass) => pass.pass)).toEqual([
      'estimate-tokens',
      LEXER,
    ]);
  });

  it('does not round, so the bracketing invariant survives the merge', () => {
    // The seam emits raw performance.now() deltas on purpose: rounding can make
    // the attributed passes exceed the bracket around them by a few thousandths
    // and turn the remainder negative inside the file itself.
    const markdown = kindOf(
      mergeParseDumps([dumpWithPasses(1, [{ pass: LEXER, calls: 1, elapsedMs: 0.000_333 }], 0.000_999)]),
      MARKDOWN,
    );
    expect(markdown.passes[0]?.elapsedMs).toBe(0.000_333);
    expect(markdown.total.elapsedMs).toBeGreaterThanOrEqual(markdown.passes[0]?.elapsedMs ?? 0);
  });

  it('sums the process wall and CPU readings across DISTINCT processes', () => {
    // Two dumps are two real processes and their lifetimes are disjoint, so they
    // add. (Whether they SHOULD add when one CONTAINS the other is the open
    // question `addLifetime` documents — it is not this assertion's subject.)
    const merged = twoProcesses();
    expect(merged.wallMs).toBe(4000);
    expect(merged.cpuUserMs).toBe(3000);
    expect(merged.cpuSystemMs).toBe(600);
    expect(merged.processes).toBe(2);
    expect(merged.mainThreads).toBe(2);
  });

  it('reports zero processes and zero threads for no dumps at all', () => {
    const merged = mergeParseDumps([]);
    expect(merged.processes).toBe(0);
    expect(merged.mainThreads).toBe(0);
    expect(merged.workerThreads).toBe(0);
    expect(merged.totalMs).toBe(0);
    expect(merged.kinds).toEqual([]);
  });
});

describe('mergeParseDumps — one process running a pool', () => {
  /** The pid the whole pool shares, because a thread is not a process. */
  const THREAD_PID = 7;

  it('reads the process lifetime ONCE however many threads ran', () => {
    // The lifetime is a property of the process, so a pool of three threads
    // reports 2000ms of wall clock and not 6000. Summing per thread inflates it
    // by exactly the pool's width, which reads as a regression of that factor —
    // and `render.ts` divides CPU by it to decide whether the wall figures can
    // be believed at all.
    const merged = mergeParseDumps([pooled(THREAD_PID, {}, { threadId: 1 }, { threadId: 2 })]);

    expect(merged.wallMs).toBe(2000);
    expect(merged.cpuUserMs).toBe(1500);
    expect(merged.cpuSystemMs).toBe(300);
  });

  it('publishes the worker thread count BESIDE the process count', () => {
    // `processes: 1` alone says a single-threaded run, and every summed
    // millisecond beside it would be read as a duration. The worker count is
    // also the denominator for utilization, so it is published rather than left
    // to be derived.
    const merged = mergeParseDumps([pooled(THREAD_PID, {}, { threadId: 1 }, { threadId: 2 })]);

    expect(merged.processes).toBe(1);
    expect(merged.mainThreads).toBe(1);
    expect(merged.workerThreads).toBe(2);
  });

  it('SUMS everything a thread measured for itself', () => {
    // The half that must not move: a merge that read only the main thread would
    // throw the workers' rows away. In the measured run the main thread held 128
    // parses and 1,805 cache misses while eight workers held ~209 parses each
    // and no misses — dropping them deletes 93% of the parses this facet exists
    // to attribute.
    const merged = mergeParseDumps([
      pooled(
        THREAD_PID,
        { cache: { hits: 2, misses: 10 } },
        { threadId: 1, cache: { hits: 2, misses: 10 } },
        { threadId: 2, cache: { hits: 2, misses: 10 } },
      ),
    ]);
    const markdown = kindOf(merged, MARKDOWN);

    expect(merged.cacheHits).toBe(6);
    expect(merged.cacheMisses).toBe(30);
    expect(merged.documents).toBe(30);
    expect(merged.bytes).toBe(3000);
    expect(markdown.total.calls).toBe(30);
    expect(markdown.total.elapsedMs).toBe(180);
    expect(markdown.passes.map((pass) => pass.calls)).toEqual([30, 30]);
    expect(markdown.passes.map((pass) => pass.elapsedMs)).toEqual([120, 30]);
  });
});

describe('mergeParseDumps — the tier, and which thread paid for it', () => {
  /** The pid a parent and its worker threads all share. */
  const POOL_PID = 11;

  /** The tier row a parent-side cache read is charged to. */
  const CACHE_READ = 'cache-read-io';

  /** The tier row a cache write is charged to. */
  const CACHE_WRITE_ROW = 'cache-write';

  /**
   * One tier row out of a merge, failing loudly when it is absent.
   *
   * @param merged - The merged numbers
   * @param pass - Which row to read
   * @returns That row
   */
  const tierOf = (merged: MergedParseDumps, pass: string): TierPassStats => {
    const found = merged.tier.find((one) => one.pass === pass);
    if (found === undefined) throw new Error(`merge carries no '${pass}' tier row`);
    return found;
  };

  /**
   * A parent and two workers of ONE process, each charging tier work.
   *
   * The shape a pooled run produces. The numbers are chosen so no two are equal
   * and no sum coincides with another: a merge that attributed a worker's cost
   * to the main thread, or summed the wrong pair, cannot land on a right answer
   * by arithmetic accident.
   *
   * @returns The merge of ONE process carrying a main thread and two workers
   */
  const pooledRun = (): MergedParseDumps =>
    mergeParseDumps([
      pooled(
        POOL_PID,
        {
          threadId: 0,
          tier: [
            { pass: CACHE_READ, calls: 3, elapsedMs: 30 },
            { pass: CACHE_WRITE_ROW, calls: 0, elapsedMs: 0 },
          ],
        },
        {
          threadId: 1,
          tier: [
            { pass: CACHE_READ, calls: 5, elapsedMs: 500 },
            { pass: CACHE_WRITE_ROW, calls: 5, elapsedMs: 700 },
          ],
        },
        {
          threadId: 2,
          tier: [
            { pass: CACHE_READ, calls: 7, elapsedMs: 1100 },
            { pass: CACHE_WRITE_ROW, calls: 7, elapsedMs: 1300 },
          ],
        },
      ),
    ]);

  it('sums a tier pass across every thread that charged it', () => {
    const merged = pooledRun();

    expect(tierOf(merged, CACHE_READ).calls).toBe(15);
    expect(tierOf(merged, CACHE_READ).elapsedMs).toBe(1630);
    expect(tierOf(merged, CACHE_WRITE_ROW).calls).toBe(12);
  });

  it('charges the MAIN-thread share from the main thread alone', () => {
    const merged = pooledRun();

    // 30, not 1,630: the two workers' reads happened in parallel on threads the
    // command was not waiting on serially. This is the whole reason `threadId`
    // is in the dump — without it these two numbers are the same number, and a
    // transport that moved 1,600ms off the parent would read as no change.
    expect(tierOf(merged, CACHE_READ).mainElapsedMs).toBe(30);
    expect(tierOf(merged, CACHE_READ).mainCalls).toBe(3);
    // The parent wrote nothing; both writes were the workers'.
    expect(tierOf(merged, CACHE_WRITE_ROW).mainElapsedMs).toBe(0);
    expect(tierOf(merged, CACHE_WRITE_ROW).calls).toBeGreaterThan(0);
  });

  it('counts the main threads, so a share has a denominator', () => {
    const merged = pooledRun();

    // 1 process, 1 main thread, 2 workers — a pool of two. The process count
    // alone cannot distinguish this from a command that never pooled anything.
    expect(merged.processes).toBe(1);
    expect(merged.mainThreads).toBe(1);
    expect(merged.workerThreads).toBe(2);
  });

  it('counts every thread as a main thread when the run had no workers', () => {
    // Two PROCESSES, each a main thread and nothing else. The contrast case for
    // the one above — three thread records either way, completely different run.
    const merged = mergeParseDumps([
      dump(1, { threadId: 0, tier: [{ pass: CACHE_READ, calls: 2, elapsedMs: 20 }] }),
      dump(2, { threadId: 0, tier: [{ pass: CACHE_READ, calls: 4, elapsedMs: 40 }] }),
    ]);

    expect(merged.mainThreads).toBe(2);
    expect(merged.workerThreads).toBe(0);
    // Every millisecond was paid on a main thread, because there were only main
    // threads. `mainElapsedMs === elapsedMs` is the honest reading here, not a
    // failure of the split.
    expect(tierOf(merged, CACHE_READ).mainElapsedMs).toBe(60);
    expect(tierOf(merged, CACHE_READ).elapsedMs).toBe(60);
  });

  it('keeps tier rows out of every parser kind', () => {
    const merged = pooledRun();

    // The placement guarantee, asserted rather than assumed: a tier row folded
    // into `kinds` would be summed into "which parser dominates this tree",
    // which is the denominator bug this facet was already bitten by one level
    // up. Nothing in the merge should be able to put it there.
    const tierNames = new Set(merged.tier.map((row) => row.pass));
    for (const kind of merged.kinds) {
      for (const pass of kind.passes) expect(tierNames.has(pass.pass)).toBe(false);
      expect(tierNames.has(kind.total.pass)).toBe(false);
    }
    expect(merged.totalMs).toBe(kindOf(merged, MARKDOWN).total.elapsedMs);
  });
});

describe('attributionOf — the states that all look like zero', () => {
  /**
   * Classify one merged shape.
   *
   * @param documents - Documents parsed, across every kind
   * @param hits - Cache hits, across every parser kind
   * @param misses - Cache misses, across every parser kind
   * @returns What those numbers describe
   */
  const classify = (documents: number, hits: number, misses: number): string =>
    attributionOf({
      processes: 1,
      mainThreads: 1,
      workerThreads: 0,
      kinds: [],
      tier: [],
      documents,
      bytes: 0,
      cacheHits: hits,
      cacheMisses: misses,
      uncachedParses: documents - misses,
      totalCalls: 0,
      totalMs: 0,
      unattributedMs: 0,
      wallMs: 0,
      cpuUserMs: 0,
      cpuSystemMs: 0,
    });

  it('calls a run with documents a measurement', () => {
    expect(classify(10, 0, 10)).toBe('measured');
  });

  it('calls a warm run all-cache-hits rather than a fast one', () => {
    // vat short-circuits the parse function on a hit, so a warm run charges no
    // passes. A table of zeroes reads as "parsing is free" unless this state is
    // named.
    expect(classify(0, 1364, 0)).toBe('all-cache-hits');
  });

  it('separates misses that no instrumented parser accounted for', () => {
    // Both of vat's parsers count their documents, so this now means a parser
    // kind the measured build does not instrument, or parses that threw. Calling
    // it "nothing was parsed" would send a reader hunting for a command that ran
    // fine — and would be exactly how an invisible parser stays invisible.
    expect(classify(0, 0, 12)).toBe('uninstrumented-only');
  });

  it('flags a run that never reached the parse path at all, distinctly', () => {
    // The suspicious one: not a warm cache, not an uninstrumented parser. If
    // this folded into all-cache-hits, "your command measured nothing" would
    // render as "your cache is working".
    expect(classify(0, 0, 0)).toBe('nothing-parsed');
  });

  it('CONTROL: documents may exceed misses, and that is still a measurement', () => {
    // Several call sites reach a parser directly, bypassing the cache. A
    // classifier that derived documents from misses would call this impossible;
    // it is routine.
    expect(classify(20, 0, 3)).toBe('measured');
  });
});

describe('sameParseWork', () => {
  /**
   * Merge one dump, so a case can vary a single field of it.
   *
   * @param over - What the case varies
   * @returns The merge
   */
  const one = (
    over: Partial<ParseThreadDump> & { process?: ParseDumpProcess } = {},
  ): MergedParseDumps => mergeParseDumps([dump(1, over)]);

  /**
   * The default merge with ONE thing about its markdown group changed.
   *
   * Every rejection case varies exactly one of: the documents, the pass call
   * counts, the pass list, the elapsed time. Spelling the whole two-group
   * fixture out per case made four near-identical literals whose differences
   * were the point and were the hardest part to see.
   *
   * @param documents - Documents the markdown group reports
   * @param totalMs - The markdown group's bracketing total
   * @param passes - Its pass rows
   * @returns The merge, with the HTML group left at its default zero
   */
  const markdownVariant = (
    documents: number,
    totalMs: number,
    passes: readonly ParseDumpPass[],
  ): MergedParseDumps =>
    one({
      kinds: [kindGroup(MARKDOWN, { count: documents, bytes: 1000 }, totalMs, passes), emptyHtmlGroup()],
    });

  /** The markdown pass rows the default fixture carries. */
  const defaultPasses: readonly ParseDumpPass[] = [
    { pass: LEXER, calls: 10, elapsedMs: 40 },
    { pass: REFERENCES, calls: 10, elapsedMs: 10 },
  ];

  it('accepts two repeats that parsed the same work', () => {
    expect(sameParseWork(one(), one())).toBe(true);
  });

  it('ignores elapsed time, which always varies', () => {
    // A stability flag that compared durations would be permanently false and
    // would say nothing about whether the two runs parsed the same corpus.
    const slower = markdownVariant(10, 600, [
      { pass: LEXER, calls: 10, elapsedMs: 400 },
      { pass: REFERENCES, calls: 10, elapsedMs: 100 },
    ]);
    expect(sameParseWork(one(), slower)).toBe(true);
  });

  it('ignores the process wall and CPU readings, which also always vary', () => {
    const busier = one({ process: { wallMs: 9000, cpuUserMs: 40, cpuSystemMs: 9 } });
    expect(sameParseWork(one(), busier)).toBe(true);
  });

  it('rejects two repeats that parsed different document counts', () => {
    expect(sameParseWork(one(), markdownVariant(9, 60, defaultPasses))).toBe(false);
  });

  it('rejects a repeat whose OTHER kind parsed different work', () => {
    // A comparison that only looked at the dominant kind would call two runs
    // identical while one of them parsed a different corpus entirely.
    const movedHtml = one({
      kinds: [
        markdownGroup(),
        kindGroup(HTML, { count: 3, bytes: 900 }, 12, [
          { pass: HTML_PARSE, calls: 3, elapsedMs: 9 },
        ]),
      ],
    });
    expect(sameParseWork(one(), movedHtml)).toBe(false);
  });

  it('rejects two repeats whose cache split moved', () => {
    expect(sameParseWork(one(), one({ cache: { hits: 1, misses: 9 } }))).toBe(false);
  });

  it('rejects a repeat whose pass call counts moved', () => {
    const fewer = markdownVariant(10, 60, [
      { pass: LEXER, calls: 9, elapsedMs: 40 },
      { pass: REFERENCES, calls: 10, elapsedMs: 10 },
    ]);
    expect(sameParseWork(one(), fewer)).toBe(false);
  });

  it('rejects a repeat that ran a pass the other did not', () => {
    const extra = markdownVariant(10, 60, [{ pass: LEXER, calls: 10, elapsedMs: 40 }]);
    expect(sameParseWork(one(), extra)).toBe(false);
  });
});

describe('readParseDumps', () => {
  it('merges every dump in the directory, not just the first', async () => {
    const merged = await expectMerge('merge-all', [
      dump(1),
      dump(2, {
        cache: { hits: 0, misses: 4 },
        kinds: [kindGroup(MARKDOWN, { count: 4, bytes: 400 }, 20, [])],
      }),
    ]);

    expect(merged.processes).toBe(2);
    expect(merged.documents).toBe(14);
    expect(kindOf(merged, MARKDOWN).total.elapsedMs).toBe(80);
  });

  it('refuses an empty directory rather than reporting zero milliseconds', async () => {
    // The load-bearing refusal: an A/B arm built before the seam existed writes
    // nothing at all, and "this build spends no time parsing" is exactly the
    // conclusion a reader would draw from a zero.
    const directory = await dumpDir('empty', {});
    const result = await readParseDumps(directory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/no parse-timing dumps/);
    // And it names the remedy rather than leaving the reader to guess at it.
    expect(result.refusal).toContain(PARSE_TIMING_DIR_ENV);
  });

  it('refuses a directory it cannot read', async () => {
    const result = await readParseDumps(safePath.join(tempDir, 'nope'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
  });

  it('refuses a dump that is not valid JSON', async () => {
    await expectRefusal('bad-json', { 'parse-timing-1.json': '{ not json' }, /not valid JSON/);
  });

  it('refuses a dump carrying an unknown field', async () => {
    await expectRefusal(
      'unknown-field',
      { 'parse-timing-1.json': JSON.stringify({ ...dump(1), gcPauseMs: 3 }) },
      /gcPauseMs|unrecognized/i,
    );
  });

  it('refuses a dump from a build that still stamped a dumpVersion, and names the producer', async () => {
    // The seam used to stamp `dumpVersion` and this reader used to compare it to
    // an integer of its own. Both are gone: strictness refuses the stale field
    // for the honest reason — this build does not model it — without anyone
    // being obliged to remember a number. The refusal must still say what to
    // re-capture with, because the commonest cause is an OLDER BUILD's dump
    // rather than a corrupt file, which is exactly what an A/B hands you.
    await expectRefusal(
      'stale-version-field',
      { 'parse-timing-1.json': JSON.stringify({ ...dump(1), dumpVersion: 2 }) },
      /dumpVersion/,
    );
    await expectRefusal(
      'stale-version-field-producer',
      { 'parse-timing-1.json': JSON.stringify({ ...dump(1), dumpVersion: 2 }) },
      /timing seam/,
    );
  });

  it('refuses a dump with no parser kinds at all', async () => {
    // Without a group there is no denominator for a share and no way to tell
    // attributed time from time nothing accounted for — so every number the
    // report could print would be unanchored.
    await expectRefusal(
      'no-kinds',
      { 'parse-timing-1.json': JSON.stringify(dump(1, { kinds: [] })) },
      /at least one parser kind/,
    );
  });

  it("refuses a group whose total does not name that group's kind", async () => {
    // A bracket that does not say which parse it brackets is one a reader can
    // charge the wrong rows against — which is exactly what a bare `total`
    // allowed when only one kind was ever instrumented.
    await expectRefusal(
      'mislabelled-total',
      {
        'parse-timing-1.json': JSON.stringify(
          dump(1, {
            kinds: [
              {
                kind: MARKDOWN,
                documents: { count: 10, bytes: 1000 },
                total: { pass: 'total', calls: 10, elapsedMs: 60 },
                passes: [{ pass: LEXER, calls: 10, elapsedMs: 40 }],
              },
            ],
          }),
        ),
      },
      /<kind>-total/,
    );
  });

  it('refuses a dump naming one pass twice within a kind', async () => {
    await expectRefusal(
      'duplicate-pass',
      {
        'parse-timing-1.json': JSON.stringify(
          dumpWithPasses(1, [
            { pass: LEXER, calls: 5, elapsedMs: 20 },
            { pass: LEXER, calls: 5, elapsedMs: 20 },
          ]),
        ),
      },
      /once within its kind/,
    );
  });

  it('refuses a dump naming one parser kind twice', async () => {
    // Two groups for one kind would each look like the whole of that kind, and
    // whichever the reader read first would be a plausible under-count.
    await expectRefusal(
      'duplicate-kind',
      {
        'parse-timing-1.json': JSON.stringify(
          dump(1, { kinds: [markdownGroup(), markdownGroup()] }),
        ),
      },
      /each parser kind once/,
    );
  });

  it('refuses a group whose total is also one of its pass rows', async () => {
    // The structural property the grouping exists for: sum the rows you are
    // given and you can never have folded a bracket into the sum.
    await expectRefusal(
      'total-among-passes',
      {
        'parse-timing-1.json': JSON.stringify(
          dumpWithPasses(1, [
            { pass: LEXER, calls: 10, elapsedMs: 40 },
            { pass: parseTotalName(MARKDOWN), calls: 10, elapsedMs: 60 },
          ]),
        ),
      },
      /once within its kind/,
    );
  });

  it('accepts a pass this build has never heard of', async () => {
    // Deliberately NOT pinned: the seam must be free to split or add a pass
    // without every dump being refused, and the per-kind remainder keeps the
    // arithmetic honest when it does.
    const merged = await expectMerge('new-pass', [
      dumpWithPasses(1, [{ pass: 'a-pass-from-the-future', calls: 10, elapsedMs: 25 }]),
    ]);

    expect(kindOf(merged, MARKDOWN).passes.map((pass) => pass.pass)).toEqual([
      'a-pass-from-the-future',
    ]);
    expect(kindOf(merged, MARKDOWN).unattributedMs).toBe(35);
  });

  it('accepts a parser kind this build has never heard of', async () => {
    // Same reasoning one level up: a build that grows a third parser must not
    // make every dump unreadable, and its group brackets itself like any other.
    const merged = await expectMerge('new-kind', [
      dump(1, {
        kinds: [
          markdownGroup(),
          kindGroup(FUTURE_KIND, { count: 7, bytes: 700 }, 50, [
            { pass: 'its-own-pass', calls: 7, elapsedMs: 30 },
          ]),
        ],
      }),
    ]);

    expect(merged.kinds.map((kind) => kind.kind)).toEqual([MARKDOWN, FUTURE_KIND]);
    expect(kindOf(merged, FUTURE_KIND).unattributedMs).toBe(20);
    expect(merged.documents).toBe(17);
  });

  it('accepts a warm dump with zero everywhere and lets the classifier speak', async () => {
    const merged = await expectMerge('warm', [
      dump(1, {
        cache: { hits: 1364, misses: 0 },
        kinds: [kindGroup(MARKDOWN, { count: 0, bytes: 0 }, 0, []), emptyHtmlGroup()],
      }),
    ]);

    // A refusal here would be wrong — the dump is a true report of a warm run.
    // What must not happen is the zeroes reading as a measurement.
    expect(merged.documents).toBe(0);
    expect(attributionOf(merged)).toBe('all-cache-hits');
  });

  it('ignores non-dump files in the directory', async () => {
    const directory = await dumpDir('with-noise', {
      'parse-timing-1.json': JSON.stringify(dump(1)),
      'notes.txt': 'not a dump',
    });
    const result = await readParseDumps(directory);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.refusal);
    expect(result.merged.documents).toBe(10);
  });
});

describe('ParseBodySchema', () => {
  it('accepts a well-formed body', () => {
    const parsed = ParseBodySchema.safeParse(parseBody([parseCommand()]));
    expect(parsed.success ? null : parsed.error.message).toBeNull();
  });

  it('accepts a negative unattributed remainder', () => {
    // Float noise from summing unrounded values, or a broken bracketing. Both
    // have to survive into the report rather than being clamped to a reassuring
    // zero — which is why this field alone is signed.
    const parsed = ParseBodySchema.safeParse(
      parseBody([parseCommand({ unattributedMs: -0.002 })]),
    );
    expect(parsed.success).toBe(true);
  });

  it('accepts fractional milliseconds at full precision', () => {
    const kinds = [
      {
        kind: MARKDOWN,
        documents: 1,
        bytes: 10,
        passes: [{ pass: LEXER, calls: 1, elapsedMs: 0.000_123_456_789 }],
        totalCalls: 1,
        totalMs: 0.000_2,
        unattributedMs: 0.000_076_543_211,
      },
    ];
    const parsed = ParseBodySchema.safeParse(parseBody([parseCommand({ kinds })]));
    expect(parsed.success ? null : parsed.error.message).toBeNull();
  });

  it('accepts a null `stable`, which is how "never established" is spelled', () => {
    const parsed = ParseBodySchema.safeParse(
      parseBody([parseCommand({ runs: 1, stable: null, totalMsSamples: [936] })]),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a body missing its attribution, which is what makes the zeroes readable', () => {
    const withoutAttribution: Record<string, unknown> = { ...parseCommand() };
    delete withoutAttribution['attribution'];
    expect(
      ParseBodySchema.safeParse({ commands: [withoutAttribution], load: parseBody([]).load })
        .success,
    ).toBe(false);
  });

  it('rejects an attribution state this build does not model', () => {
    const parsed = ParseBodySchema.safeParse(
      parseBody([parseCommand({ attribution: 'warm' as never })]),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown field, because we wrote this body', () => {
    const parsed = ParseBodySchema.safeParse({
      ...parseBody([{ ...parseCommand(), gcPauseMs: 12 } as never]),
    });
    expect(parsed.success).toBe(false);
  });
});
