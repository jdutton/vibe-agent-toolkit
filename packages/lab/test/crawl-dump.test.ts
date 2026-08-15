/**
 * The `crawl` facet's dump reader.
 *
 * Four of these guard against a *confident wrong number* rather than a crash:
 *
 * 1. **The env-var literal is pinned.** `VAT_CRAWL_TIMING` is the whole contract
 *    with a vat that was built separately, and the lab deliberately does not
 *    import it from `@vibe-agent-toolkit/resources` — an A/B arm may be a build
 *    that has no seam at all, so the facet has to compile against, and refuse
 *    cleanly for, a vat that has never heard of it. That decision only holds if
 *    something pins the spelling.
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
  crawlTimingStart,
  recordCrawlPass,
} from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CRAWL_DUMP_VERSION,
  CRAWL_TIMING_DIR_ENV,
  crawlAttributionOf,
  type CrawlDump,
  type CrawlDumpEntry,
  crawlEntryKey,
  CrawlDumpSchema,
  mergeCrawlDumps,
  readCrawlDumps,
  sameCrawlWork,
} from '../src/facets/crawl/dump.js';

import { writeDumpDir } from './dump-fixtures.js';

/** Fixture constants, named so the same string never appears twice. */
const WALKER = 'walk-link-graph:walk';
const GITIGNORE = 'walk-link-graph:gitignore';
const CLOSURE = 'closure:my-bundle';
const CRAWL_STRATUM = 'crawl';
const CLOSURE_STRATUM = 'closure';

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
    expect(byStratum.get(CRAWL_STRATUM)?.elapsedMs).toBe(44);
    expect(byStratum.get(CLOSURE_STRATUM)?.elapsedMs).toBe(140);
    expect(merged.totalMs).toBe(184);
    expect(merged.totalCalls).toBe(12);
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
    expect(read.merged.totalMs).toBe(184);
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
   * `@vibe-agent-toolkit/resources` is a **devDependency** of the lab for this
   * test alone. `src/facets/crawl/dump.ts` still declares the env var and the
   * dump shape as its own literals, so the published facet compiles against a
   * vat that has never heard of the seam — which is the property that lets an
   * A/B arm be an older build. This edge exists only so a test can produce a
   * genuine artifact instead of a drawing of one.
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
