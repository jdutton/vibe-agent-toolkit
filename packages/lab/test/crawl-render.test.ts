/**
 * Rendering a `crawl` report.
 *
 * Every assertion here is about a sentence a reader would otherwise draw the
 * wrong conclusion from:
 *
 * - **The entry column does not add up to the headline, and has to say why.**
 *   Some brackets are charged from inside others, so their milliseconds are
 *   already in the row containing them and are excluded from every total. A
 *   reader who adds the column up and gets a bigger number than the headline
 *   will conclude the report does not reconcile — and will be right, unless the
 *   report tells them which rows are breakdowns.
 * - **A total that is short by an unknown amount must never look complete.**
 *   A bracket this build cannot place goes in neither total, which is the only
 *   answer that cannot be wrong; printing it silently would turn that honesty
 *   into an unremarked under-count.
 * - **The per-stratum line is the one the facet exists for**, so it is the
 *   figure the nesting rule protects: the two crawlers nest to different depths,
 *   and a total that included nested rows would compare a walk on one arm
 *   against a walk-plus-its-oracle on the other.
 *
 * The rows are built by the real reader, not hand-written: a fixture that
 * carried its own rollup could only ever prove the renderer is self-consistent
 * with a table nothing produces.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { type CrawlDump, mergeCrawlDumps } from '../src/facets/crawl/dump.js';
import { renderCrawlReport } from '../src/facets/crawl/render.js';
import {
  CRAWL_FACET,
  type CrawlBody,
  type CrawlCommandStats,
} from '../src/facets/crawl/types.js';

import { CLEAN_LOAD, makeReport } from './report-fixtures.js';

/** The incumbent walker's own traversal — a top-level span. */
const WALK_MS = 30;

/** Its gitignore oracle, charged from INSIDE the walk above. */
const ORACLE_MS = 14;

/** A projection contributor's driver-placed row. */
const CLOSURE_MS = 100;

/** A bracket under an id this build has never heard of. */
const UNKNOWN_MS = 7;

/** The `GitTracker` initialization — in the command's total, in neither arm. */
const TRACKER_MS = 20;

/** The incumbent arm's rendered figure, asserted from more than one angle. */
const CRAWL_ARM_LINE = 'crawl 30.0ms';

/**
 * One process's dump, carrying one row of each role.
 *
 * @param entries - The rows
 * @returns The dump
 */
function dumpOf(entries: CrawlDump['entries']): CrawlDump {
  return {
    pid: 42,
    process: { wallMs: 1000, cpuUserMs: 800, cpuSystemMs: 100 },
    charges: { strata: ['base', 'closure', 'crawl', 'shared'], syntheticIds: [] },
    entries,
  };
}

/** A walk, the oracle inside it, and a closure contributor beside both. */
const NESTED_ROWS: CrawlDump['entries'] = [
  { contributorId: 'walk-link-graph:walk', stratum: 'crawl', pass: 0, calls: 3, elapsedMs: WALK_MS },
  {
    contributorId: 'walk-link-graph:gitignore',
    stratum: 'crawl',
    pass: 0,
    calls: 7,
    elapsedMs: ORACLE_MS,
  },
  {
    contributorId: 'closure:my-bundle',
    stratum: 'closure',
    pass: 1,
    calls: 1,
    elapsedMs: CLOSURE_MS,
  },
];

/**
 * Render a report of one command whose crawl produced the given rows.
 *
 * @param entries - The seam's rows
 * @returns The rendered text
 */
function render(entries: CrawlDump['entries']): string {
  const merged = mergeCrawlDumps([dumpOf(entries)]);
  const command: CrawlCommandStats = {
    name: 'inventory',
    args: ['inventory'],
    cache: 'warm',
    runs: 3,
    stable: true,
    attribution: 'measured',
    charges: merged.charges,
    entries: merged.entries,
    strata: merged.strata,
    totalCalls: merged.totalCalls,
    totalMs: merged.totalMs,
    totalMsSamples: [merged.totalMs],
    processes: merged.processes,
    failed: false,
    failure: null,
  };
  const body: CrawlBody = { commands: [command], load: CLEAN_LOAD };
  return renderCrawlReport(
    makeReport({
      facet: CRAWL_FACET,
      body,
    }) as ReportEnvelope<CrawlBody>,
  );
}

describe('renderCrawlReport — nesting', () => {
  it('totals the two crawlers without the brackets charged inside them', () => {
    // 30, not 44. The oracle's milliseconds are real and are already inside the
    // walk; adding them would make the incumbent arm look half again as
    // expensive as it is, and would do so on only one of the two arms.
    expect(render(NESTED_ROWS)).toContain(CRAWL_ARM_LINE);
  });

  it('states the nested time rather than leaving the column unreconcilable', () => {
    const text = render(NESTED_ROWS);

    // Without this line a reader adds 30 + 14 + 100 = 144 against a headline of
    // 130 and concludes the instrument is broken.
    expect(text).toContain('of which nested inside the rows above (NOT added): 14.0ms');
  });

  it('marks the nested row itself, where the reader is looking at the number', () => {
    const text = render(NESTED_ROWS);
    const oracle = text
      .split('\n')
      .find((line) => line.includes('walk-link-graph:gitignore'));

    // The legend at the top is not enough: the misreading happens at the row.
    expect(oracle).toContain('⊂');
    expect(text.split('\n').find((line) => line.includes('walk-link-graph:walk'))).not.toContain(
      '⊂',
    );
  });

  it('explains the mark in the legend, which travels when the block is pasted', () => {
    expect(render(NESTED_ROWS)).toContain('a row marked ⊂ is charged from INSIDE one above it');
  });

  it('says nothing about nesting when every row is a top-level span', () => {
    // The line is a correction to an inference the reader would otherwise draw,
    // so on a report where the column really does add up it would be noise.
    expect(render([NESTED_ROWS[0] as CrawlDump['entries'][number]])).not.toContain(
      'of which nested',
    );
  });
});

describe('renderCrawlReport — a stratum that is not an arm', () => {
  /** The same run, plus the tracker initialization both crawlers consume. */
  const WITH_SHARED: CrawlDump['entries'] = [
    ...NESTED_ROWS,
    {
      contributorId: 'git-tracker:initialize',
      stratum: 'shared',
      pass: 0,
      calls: 1,
      elapsedMs: TRACKER_MS,
    },
  ];

  it('counts it in the command total, because the command paid for it', () => {
    // 130 + 20. Leaving it out would be the under-count the `shared` stratum was
    // introduced to end — and a symmetric under-count is still an under-count.
    expect(render(WITH_SHARED)).toContain('150.0ms');
  });

  it('leaves BOTH arms exactly where they were', () => {
    const text = render(WITH_SHARED);

    // The whole hazard: charging shared preparation to `crawl` would put it on
    // the incumbent's total and make the projection look better than it is, on a
    // cost flipping a verb would not remove.
    expect(text).toContain(CRAWL_ARM_LINE);
    expect(text).toContain('closure 100.0ms');
  });

  it('marks it, so no reader adds it to an arm', () => {
    const text = render(WITH_SHARED);

    // A reader who reconciles 30 + 100 + 20 against the headline needs to be told
    // which of the three is not a crawler, at the place they are reading it.
    expect(text).toContain('shared† 20.0ms');
    expect(text).toContain('preparation BOTH crawlers consume and NEITHER owns');
  });

  it('says none of that on a run with no shared row', () => {
    // The footnote explains a mark. With nothing marked it is an answer to a
    // question the reader did not ask.
    expect(render(NESTED_ROWS)).not.toContain('preparation BOTH crawlers consume');
  });
});

describe('renderCrawlReport — rows this build cannot place', () => {
  /** The same run, plus a bracket under an unrecognised id. */
  const WITH_UNKNOWN: CrawlDump['entries'] = [
    ...NESTED_ROWS,
    {
      contributorId: 'walk-link-graph:something-new',
      stratum: 'crawl',
      pass: 0,
      calls: 2,
      elapsedMs: UNKNOWN_MS,
    },
  ];

  it('says the crawl cost is an UNDER-count, in those words', () => {
    const text = render(WITH_UNKNOWN);

    // The failure this facet must never produce is a total short by an unknown
    // amount with nothing saying so — which is exactly what excluding an
    // unplaceable row would be, on its own.
    expect(text).toContain('could not be placed as either');
    expect(text).toContain('UNDER-count');
  });

  it('leaves the totals alone rather than guessing which way the row nests', () => {
    // Neither 30 + 7 (which double-counts if it nests) nor folded into the
    // nested figure (which hides it if it does not).
    const text = render(WITH_UNKNOWN);

    expect(text).toContain(CRAWL_ARM_LINE);
    expect(text).toContain('of which nested inside the rows above (NOT added): 14.0ms');
  });
});
