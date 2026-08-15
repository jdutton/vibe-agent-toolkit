/**
 * The `crawl` facet's dump reader.
 *
 * Five of these guard against a *confident wrong number* rather than a crash:
 *
 * 0. **Nested brackets are not added to the rows containing them.** The reader
 *    summed a stratum's rows regardless until 2026-08-15, so the walk and the
 *    gitignore oracle charged from inside it both landed in the `crawl` total.
 *    Every figure was a real duration; the total was of nothing. The fixture
 *    below makes the two readings differ (44 against 30), and the arms nest to
 *    different depths, so the error was not even a constant factor.
 *
 * 1. **The env-var literal is pinned.** `VAT_CRAWL_TIMING` is the whole contract
 *    with a vat that was built separately, and the lab deliberately does not
 *    import it from `@vibe-agent-toolkit/utils` — an A/B arm may be a build
 *    that has no seam at all, so the facet has to compile against, and refuse
 *    cleanly for, a vat that has never heard of it. That decision only holds if
 *    something pins the spelling — and it matters more since the seam moved into
 *    `utils`, which the lab depends on at runtime, putting the tempting import
 *    within reach of every file in the facet.
 * 2. **Merging across PIDs.** One vat invocation spawns a child per phase, so a
 *    reader that took the first file it found would report one phase's timings
 *    and look perfectly healthy doing it. The fixtures give the two PIDs
 *    *different* numbers, so a first-file reader, a last-file reader and a
 *    merging reader all produce visibly different answers.
 * 3. **An empty directory is a refusal; an empty `entries` array is a reading.**
 *    These are different facts — no seam, versus a command that reached no
 *    crawler — and vat's seam files a dump even when it charged nothing
 *    precisely so a reader can tell them apart.
 * 4. **Process lifetimes are never totalled.** The merge publishes one record
 *    per DUMP and no sum anywhere. `parse` sums `wallMs` across dumps and its
 *    trust ratio is systematically deflated as a result: the parent orchestrator
 *    is alive for the whole run, so its lifetime contains every child's. The
 *    fixture here makes the two readings differ, which is what `parse`'s own
 *    two-process fixture could not do.
 *
 * The end-to-end round trip — vat's real seam writing a file this reader then
 * accepts — is pinned separately, at the bottom of this file, against the exact
 * bytes the seam produces rather than against a fixture that merely looks like
 * them.
 */

import { mkdtemp } from 'node:fs/promises';

import {
  __setCrawlTimingForTest,
  __writeCrawlTimingDumpForTest,
  CRAWL_PASS_INSIDE,
  CRAWL_SEAM_DUMP_VERSION,
  crawlTimingStart,
  normalizedTmpdir,
  recordCrawlPass,
  safePath,
} from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CRAWL_DUMP_VERSION,
  CRAWL_INCUMBENT_STRATUM,
  CRAWL_SHARED_STRATUM,
  CRAWL_TIMING_DIR_ENV,
  crawlAttributionOf,
  type CrawlDump,
  type CrawlDumpEntry,
  crawlEntryKey,
  CrawlDumpSchema,
  crawlRowRole,
  mergeCrawlDumps,
  readCrawlDumps,
  sameCrawlWork,
} from '../src/facets/crawl/dump.js';

import { writeDumpDir } from './dump-fixtures.js';

/** Fixture constants, named so the same string never appears twice. */
const WALKER = 'walk-link-graph:walk';
const GITIGNORE = 'walk-link-graph:gitignore';
const CONTRIBUTE = 'closure-extent:contribute';
const RESOLVE = 'closure-extent:resolve-reference';
const REGISTRY_ENUMERATE = 'resource-registry:enumerate';
const GIT_TRACKER = 'git-tracker:initialize';
const CLOSURE = 'closure:my-bundle';
const CRAWL_STRATUM = 'crawl';
const CLOSURE_STRATUM = 'closure';
const BASE_STRATUM = 'base';

/** The pass a bracket placed inside the measured work records. */
const INSIDE = 0;

/**
 * One row.
 *
 * @param contributorId - The row's id
 * @param stratum - The row's layer
 * @param pass - The row's pass
 * @param calls - How many invocations
 * @param elapsedMs - Their summed time
 * @returns The row
 */
function entry(
  contributorId: string,
  stratum: string,
  pass: number,
  calls: number,
  elapsedMs: number,
): CrawlDumpEntry {
  return { contributorId, stratum, pass, calls, elapsedMs };
}

/**
 * One dump.
 *
 * @param pid - The process id
 * @param wallMs - That process's lifetime
 * @param entries - Its rows
 * @returns The dump
 */
function dump(pid: number, wallMs: number, entries: readonly CrawlDumpEntry[]): CrawlDump {
  return {
    dumpVersion: CRAWL_DUMP_VERSION,
    pid,
    process: { wallMs, cpuUserMs: wallMs / 2, cpuSystemMs: wallMs / 4 },
    entries,
  };
}

/**
 * A long-lived parent that crawled nothing, and the child that did the work.
 *
 * This is the shape `parse`'s reader gets wrong: the parent orchestrator's
 * lifetime CONTAINS the child's, so summing the two double-counts real time. The
 * numbers are chosen so a sum (3000) and a maximum (2000) are visibly different.
 */
const PARENT = dump(101, 2000, []);
const CHILD = dump(202, 1000, [
  entry(WALKER, CRAWL_STRATUM, INSIDE, 3, 30),
  entry(GITIGNORE, CRAWL_STRATUM, INSIDE, 7, 14),
  entry(CLOSURE, CLOSURE_STRATUM, 1, 1, 100),
  entry(CLOSURE, CLOSURE_STRATUM, 2, 1, 40),
]);

describe('crawl dump contract', () => {
  it('pins the env var the seam is switched on by', () => {
    // Not imported from the package that writes it: an A/B arm may be a build
    // with no seam, so the lab must compile against a vat that has never heard
    // of this. That only holds if the spelling is pinned here.
    expect(CRAWL_TIMING_DIR_ENV).toBe('VAT_CRAWL_TIMING');
  });

  it('pins this reader to the version the seam actually writes', () => {
    // The env var above is deliberately NOT imported from the writer, because an
    // A/B arm may be a seamless build. The VERSION is the opposite case, and the
    // difference is worth stating: the reader hard-refuses any version it does
    // not recognise, so when these two drift the symptom is not a subtly wrong
    // number — it is EVERY dump this build writes being rejected, which reads to
    // the operator as a broken invocation rather than a stale constant. Two
    // unrelated literals in two packages could drift silently and nothing would
    // fail until someone tried to measure. So this one is pinned against the
    // writer itself.
    //
    // ⚠️ This asserts the two are EQUAL, not that either equals a literal. A
    // literal on both sides would still pass while both were wrong together, and
    // would additionally have to be edited in two places on every bump — which
    // is precisely the drift this exists to prevent.
    expect(CRAWL_DUMP_VERSION).toBe(CRAWL_SEAM_DUMP_VERSION);
  });

  it('accepts a dump with no rows at all', () => {
    // The reading that says "the command reached no crawler". Refusing it would
    // make a real finding indistinguishable from an instrument failure.
    expect(CrawlDumpSchema.safeParse(PARENT).success).toBe(true);
  });

  it('refuses two rows for one (contributorId, stratum, pass)', () => {
    const duplicated = dump(1, 10, [
      entry(WALKER, CRAWL_STRATUM, INSIDE, 1, 1),
      entry(WALKER, CRAWL_STRATUM, INSIDE, 2, 2),
    ]);

    expect(CrawlDumpSchema.safeParse(duplicated).success).toBe(false);
  });

  it('keys a row on its stratum and pass as well as its id', () => {
    // The same contributor really is charged once per fixpoint pass, and those
    // rows must not collapse: "cheap but run every pass" and "expensive once"
    // are the distinction the axis exists to preserve.
    expect(crawlEntryKey(entry(CLOSURE, CLOSURE_STRATUM, 1, 1, 1))).not.toBe(
      crawlEntryKey(entry(CLOSURE, CLOSURE_STRATUM, 2, 1, 1)),
    );
  });
});

describe('mergeCrawlDumps', () => {
  it('sums a row across every process that charged it', () => {
    const merged = mergeCrawlDumps([
      CHILD,
      dump(303, 500, [entry(WALKER, CRAWL_STRATUM, INSIDE, 2, 20)]),
    ]);

    const walker = merged.entries.find((row) => row.contributorId === WALKER);
    expect(walker?.calls).toBe(5);
    expect(walker?.elapsedMs).toBe(50);
  });

  it('rolls the rows up per stratum, which is the crawler-against-crawler line', () => {
    const merged = mergeCrawlDumps([CHILD]);

    const byStratum = new Map(merged.strata.map((row) => [row.stratum, row]));
    // The incumbent walker's own work against the projection closure's, from one
    // dump. This comparison is the reason the facet exists.
    //
    // 30, NOT 44: the gitignore oracle's 14 ms are charged from inside the walk
    // and are already in the walk's row. This reader summed them anyway until
    // 2026-08-15, which inflated both arms — and by different factors, since the
    // two nest to different depths.
    expect(byStratum.get(CRAWL_STRATUM)?.elapsedMs).toBe(30);
    expect(byStratum.get(CLOSURE_STRATUM)?.elapsedMs).toBe(140);
    expect(merged.totalMs).toBe(170);
    expect(merged.totalCalls).toBe(5);
  });

  it('publishes the nested time beside the total rather than dropping it', () => {
    const merged = mergeCrawlDumps([CHILD]);

    const byStratum = new Map(merged.strata.map((row) => [row.stratum, row]));
    // Excluded from the total, and still answerable: "the walk spent 14 of its
    // 30 ms reading the gitignore oracle". An absent number here would be
    // indistinguishable from an oracle that was never consulted.
    expect(byStratum.get(CRAWL_STRATUM)?.nested).toEqual({ calls: 7, elapsedMs: 14 });
    // And a stratum with no nested rows says zero rather than nothing, so the
    // reader can tell "none" from "not looked for".
    expect(byStratum.get(CLOSURE_STRATUM)?.nested).toEqual({ calls: 0, elapsedMs: 0 });
  });

  it('publishes one process record per DUMP and no total lifetime anywhere', () => {
    const merged = mergeCrawlDumps([PARENT, CHILD]);

    // One per dump, not per distinct pid: pids are reused across a multi-phase
    // run, which is why the seam's filenames carry a collision counter.
    expect(merged.processes.map((record) => record.pid)).toEqual([101, 202]);
    expect(merged.processes.map((record) => record.wallMs)).toEqual([2000, 1000]);
    // And no summed lifetime exists to be read. The sum (3000) exceeds the real
    // elapsed time of the run, because the parent was alive for the child.
    expect(Object.keys(merged)).not.toContain('wallMs');
  });

  it('counts two dumps from ONE pid as two processes', () => {
    // `parse`'s reader counts distinct pids and reports these as one. Pids are
    // reused across a long multi-phase run — the seam carries a filename
    // collision counter for exactly that reason.
    const merged = mergeCrawlDumps([
      dump(7, 10, [entry(WALKER, CRAWL_STRATUM, INSIDE, 1, 1)]),
      dump(7, 20, [entry(WALKER, CRAWL_STRATUM, INSIDE, 1, 1)]),
    ]);

    expect(merged.processes).toHaveLength(2);
  });

  it('distinguishes a crawl that happened from one that did not', () => {
    expect(crawlAttributionOf(mergeCrawlDumps([CHILD]))).toBe('measured');
    expect(crawlAttributionOf(mergeCrawlDumps([PARENT]))).toBe('nothing-crawled');
  });
});

describe('crawlRowRole', () => {
  it('pins the incumbent stratum this build decides by id', () => {
    // The one stratum name the lab asserts. Everywhere else `stratum` is an open
    // string on purpose — a vat that grows a fourth stratum must not make every
    // dump unreadable — so this is the single spelling that has to hold, and the
    // consequence of it drifting is that every incumbent row falls to
    // `unclassified` and both totals silently shrink.
    expect(CRAWL_INCUMBENT_STRATUM).toBe('crawl');
  });

  it('calls a driver-placed row additive whatever stratum it is in', () => {
    // Only the merge driver numbers passes, from 1, around a whole contributor
    // invocation. Nothing in a dump can contain one.
    expect(crawlRowRole(entry(CLOSURE, CLOSURE_STRATUM, 1, 1, 100))).toBe('additive');
    expect(crawlRowRole(entry('git', BASE_STRATUM, 1, 1, 5))).toBe('additive');
  });

  it('calls a pass-0 row in a driver stratum nested, because the driver already timed it', () => {
    // `contribute` and its per-reference resolution both sit inside the driver's
    // bracket for the same invocation — reached through the AsyncLocalStorage the
    // driver wraps that invocation in, which is exactly the span it timed.
    expect(crawlRowRole(entry(CONTRIBUTE, CLOSURE_STRATUM, INSIDE, 4, 60))).toBe('nested');
    expect(crawlRowRole(entry(RESOLVE, CLOSURE_STRATUM, INSIDE, 900, 20))).toBe('nested');
    // Including a registry build reached from inside a contributor: the stratum
    // it inherited is what places it, not its id.
    expect(crawlRowRole(entry(REGISTRY_ENUMERATE, BASE_STRATUM, INSIDE, 1, 9))).toBe('nested');
  });

  it('decides the incumbent stratum by id, where every row is pass 0', () => {
    // The walker has no driver, so its rows are all pass 0 and the pass cannot
    // discriminate. The registry's three phases are disjoint spans that feed the
    // walk; the gitignore oracle is read from within it.
    expect(crawlRowRole(entry(REGISTRY_ENUMERATE, CRAWL_STRATUM, INSIDE, 1, 9))).toBe('additive');
    expect(crawlRowRole(entry(WALKER, CRAWL_STRATUM, INSIDE, 3, 30))).toBe('additive');
    expect(crawlRowRole(entry(GITIGNORE, CRAWL_STRATUM, INSIDE, 7, 14))).toBe('nested');
  });

  it('decides the shared stratum by id too, and its one row is additive', () => {
    // `shared` holds work both crawlers consume and neither owns. It has no
    // driver either, so it is placed by id on the same rule as the incumbent —
    // which is why the two live in one table rather than in two branches.
    expect(CRAWL_SHARED_STRATUM).toBe('shared');
    expect(crawlRowRole(entry(GIT_TRACKER, CRAWL_SHARED_STRATUM, INSIDE, 1, 147))).toBe('additive');
  });

  it('refuses an unknown id in the shared stratum, rather than trusting the stratum', () => {
    // A known stratum is not a licence to place an unknown bracket. `shared` is
    // where a future cross-arm cost would go, and the first such bracket must
    // announce itself as an under-count rather than being waved through as
    // additive because its neighbour is.
    expect(crawlRowRole(entry('git-tracker:something-new', CRAWL_SHARED_STRATUM, INSIDE, 1, 5))).toBe(
      'unclassified',
    );
  });

  it('refuses to place a bracket it has never heard of', () => {
    // The honest answer, and the one that cannot be wrong. Guessing by
    // resemblance — "it looks like a walker row, call it additive" — is how the
    // double-counting this function exists to fix gets rebuilt one bracket at a
    // time.
    expect(crawlRowRole(entry('walk-link-graph:something-new', CRAWL_STRATUM, INSIDE, 1, 5))).toBe(
      'unclassified',
    );
    // And a pass-0 row in a stratum that is neither the incumbent's nor the
    // driver's: a fourth stratum is allowed to exist, but this build cannot say
    // how its brackets nest.
    expect(crawlRowRole(entry('whatever', 'some-new-stratum', INSIDE, 1, 5))).toBe('unclassified');
  });
});

describe('unclassified rows', () => {
  /** A run whose walker filed a bracket this build does not model. */
  const WITH_UNKNOWN = dump(404, 1000, [
    entry(WALKER, CRAWL_STRATUM, INSIDE, 3, 30),
    entry('walk-link-graph:something-new', CRAWL_STRATUM, INSIDE, 2, 7),
  ]);

  it('counts them in NEITHER total', () => {
    const merged = mergeCrawlDumps([WITH_UNKNOWN]);

    // Not folded into the total (which would double-count if it nests) and not
    // folded into `nested` (which would hide it if it does not). 30, not 37.
    expect(merged.totalMs).toBe(30);
    expect(merged.strata[0]?.nested).toEqual({ calls: 0, elapsedMs: 0 });
  });

  it('publishes them, so the under-count is visible rather than silent', () => {
    const merged = mergeCrawlDumps([WITH_UNKNOWN]);

    // The row this facet must never produce is a total that is short by an
    // unknown amount with nothing saying so.
    expect(merged.strata[0]?.unclassified).toEqual({ calls: 2, elapsedMs: 7 });
  });
});

describe('sameCrawlWork', () => {
  it('ignores the durations, which always move', () => {
    const slower = dump(202, 9999, CHILD.entries.map((row) => ({ ...row, elapsedMs: row.elapsedMs * 3 })));

    expect(sameCrawlWork(mergeCrawlDumps([CHILD]), mergeCrawlDumps([slower]))).toBe(true);
  });

  it('sees a changed call count', () => {
    const busier = dump(202, 1000, [
      ...CHILD.entries.slice(1),
      entry(WALKER, CRAWL_STRATUM, INSIDE, 4, 30),
    ]);

    expect(sameCrawlWork(mergeCrawlDumps([CHILD]), mergeCrawlDumps([busier]))).toBe(false);
  });

  it('sees a row that appeared', () => {
    const extra = dump(202, 1000, [...CHILD.entries, entry('closure:other', CLOSURE_STRATUM, 1, 1, 5)]);

    expect(sameCrawlWork(mergeCrawlDumps([CHILD]), mergeCrawlDumps([extra]))).toBe(false);
  });
});

describe('readCrawlDumps', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-lab-crawl-dump-test-'));
  });

  it('reads EVERY dump in the directory, not the first', async () => {
    const directory = await writeDumpDir(root, 'two-processes', {
      'crawl-timing-101.json': JSON.stringify(PARENT),
      'crawl-timing-202.json': JSON.stringify(CHILD),
    });

    const read = await readCrawlDumps(directory);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // A first-file reader would report `nothing-crawled` here — a perfectly
    // well-formed lie about a run that did real work.
    expect(read.merged.processes).toHaveLength(2);
    expect(read.merged.totalMs).toBe(170);
  });

  it('refuses an empty directory rather than reporting zero', async () => {
    const directory = await writeDumpDir(root, 'empty', {});

    const read = await readCrawlDumps(directory);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal).toContain('REFUSED:');
    // And it says which of the two zero-states this is not, because the seam
    // files a dump even when it charged nothing.
    expect(read.refusal).toContain('crawled nothing');
  });

  it('refuses a dump from another version of the seam', async () => {
    const directory = await writeDumpDir(root, 'wrong-version', {
      'crawl-timing-1.json': JSON.stringify({ ...CHILD, dumpVersion: CRAWL_DUMP_VERSION + 1 }),
    });

    const read = await readCrawlDumps(directory);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal).toContain('crawl-timing seam');
  });

  it('refuses text that is not a dump at all', async () => {
    const directory = await writeDumpDir(root, 'malformed', {
      'crawl-timing-1.json': '{ not json',
    });

    const read = await readCrawlDumps(directory);
    expect(read.ok).toBe(false);
  });

  /**
   * The bytes vat's seam really writes, read by this reader.
   *
   * Every case above validates a fixture the LAB wrote, which can only ever
   * prove the reader is self-consistent. Two independently-maintained literals
   * that both describe "the dump" agree right up until one of them is edited,
   * and then a schema that still passes its own fixtures starts refusing every
   * real dump — the failure this whole file is otherwise blind to.
   *
   * The seam is reached through `@vibe-agent-toolkit/utils`, which the lab
   * already depends on. (It was a `resources` **devDependency** until the seam
   * moved down on 2026-08-15; that edge is gone, and `dependency-check` is what
   * noticed.) `src/facets/crawl/dump.ts` still declares the env var and the dump
   * shape as its own literals, so the published facet compiles against a vat
   * that has never heard of the seam — which is the property that lets an A/B
   * arm be an older build. This test exists only so that claim is checked
   * against a genuine artifact instead of a drawing of one.
   */
  it('accepts a dump the real seam wrote, not a drawing of one', async () => {
    const directory = safePath.join(root, 'from-the-real-seam');
    __setCrawlTimingForTest(directory);
    try {
      const startedAt = crawlTimingStart();
      recordCrawlPass(WALKER, CRAWL_STRATUM, CRAWL_PASS_INSIDE, startedAt);
      expect(__writeCrawlTimingDumpForTest()).not.toBeNull();
    } finally {
      __setCrawlTimingForTest(null);
    }

    const read = await readCrawlDumps(directory);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.merged.processes).toHaveLength(1);
    expect(read.merged.processes[0]?.pid).toBe(process.pid);
    expect(read.merged.entries.map((row) => row.contributorId)).toEqual([WALKER]);
    expect(read.merged.totalCalls).toBe(1);
    expect(crawlAttributionOf(read.merged)).toBe('measured');
  });

  it('accepts a real dump that charged nothing, as a reading rather than a refusal', async () => {
    const directory = safePath.join(root, 'from-the-real-seam-idle');
    __setCrawlTimingForTest(directory);
    __writeCrawlTimingDumpForTest();
    __setCrawlTimingForTest(null);

    const read = await readCrawlDumps(directory);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The whole reason the seam files a dump even when it charged nothing.
    expect(crawlAttributionOf(read.merged)).toBe('nothing-crawled');
  });
});
