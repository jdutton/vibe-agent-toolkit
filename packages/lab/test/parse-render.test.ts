/**
 * Rendering a `parse` report.
 *
 * Every assertion here is about a sentence a reader would otherwise draw the
 * wrong conclusion from:
 *
 * - **A minority parser's breakdown must not read as the tree's parse cost.**
 *   This is the one that motivated the facet's current shape. A tidy table of
 *   eight rows describing 3% of the time is the most convincing possible way to
 *   describe a corpus wrongly, so the dominant parser kind is named before any
 *   breakdown and every pass share is a share of its own kind.
 * - **Zeroes must not read as "free".** A warm capture is a well-formed body
 *   full of zeroes, and printed as a table it says parsing costs nothing. The
 *   four empty states each render as a sentence naming themselves, and the two
 *   that look identical in the numbers — a warm cache and a command that never
 *   parsed — must not render alike.
 * - **The unattributed remainder is always printed**, because it is the only
 *   thing that says whether the breakdown above it is a complete explanation.
 * - **The cache rate is over every parser kind and says so.** Presented as a
 *   per-document rate it would invite the reader to reconcile it against the
 *   document count, which is not an arithmetic that holds in either direction.
 * - **These are not wall-clock milliseconds.** They are summed across the
 *   processes one vat command spawns, and a reader who took them for wall time
 *   would try to reconcile them against a `perf` median forever.
 * - **Wall against CPU qualifies every figure above it.** The passes are
 *   wall-timed, so a process that spent its life waiting has that waiting spread
 *   through the whole breakdown, and the report says so in a sentence rather
 *   than printing two numbers for the reader to divide.
 */

import { describe, expect, it } from 'vitest';

import { renderParseComparison, renderParseReport } from '../src/facets/parse/render.js';
import type { ParseCommandStats, ParseKindStats } from '../src/facets/parse/types.js';

import {
  ATTRIBUTED_MS,
  compareOneParseCommand,
  DOCUMENTS,
  HTML_DOCUMENTS,
  HTML_DOMINANT_KINDS,
  HTML_TOTAL_MS,
  htmlPasses,
  MARKDOWN_TOTAL_MS,
  PASSES,
  parseBody,
  parseCommand,
  parseKind,
  parseReport,
} from './parse-fixtures.js';
import { BUSY_LOAD } from './report-fixtures.js';

/** The pass every assertion about a single row's figures reaches for. */
const LEXER = 'remark-parse';

/**
 * Render a report of one command.
 *
 * @param over - What the case varies about that command
 * @returns The rendered text
 */
function render(over: Partial<ParseCommandStats> = {}): string {
  return renderParseReport(parseReport([parseCommand(over)]));
}

/**
 * The default corpus with the markdown group's remainder forced to a value.
 *
 * @param unattributedMs - The remainder to publish
 * @returns Both kinds, markdown carrying the given remainder
 */
function withMarkdownRemainder(unattributedMs: number): readonly ParseKindStats[] {
  return [
    { ...parseKind('markdown', DOCUMENTS, MARKDOWN_TOTAL_MS, PASSES), unattributedMs },
    parseKind('html', HTML_DOCUMENTS, HTML_TOTAL_MS, htmlPasses(HTML_DOCUMENTS, HTML_TOTAL_MS)),
  ];
}

describe('renderParseReport — the header', () => {
  it('names the coordinate and warns that the milliseconds are not wall time', () => {
    const text = render();
    expect(text).toContain('Subject:');
    expect(text).toContain('Instrument: vat 0.1.42');
    expect(text).toMatch(/Not wall time/);
  });

  it('says when the machine was contaminated', () => {
    const text = renderParseReport(
      parseReport([parseCommand()], { body: parseBody([parseCommand()], BUSY_LOAD) }),
    );
    expect(text).toMatch(/CONTAMINATED/);
  });
});

describe('renderParseReport — which parser kind owns the cost', () => {
  it('names the dominant parser kind BEFORE any breakdown', () => {
    // The acceptance criterion. On a corpus made almost entirely of one kind, a
    // reader must be told which kind that is before they can mistake the other
    // kind's tidy table for the shape of the tree.
    const text = render({ kinds: HTML_DOMINANT_KINDS });

    expect(text).toMatch(/HTML DOMINATES/);
    expect(text).toMatch(/Read the html breakdown first/);
    // And the minority kind's own heading repeats how little it describes, so
    // the warning cannot be lost by scrolling past it.
    expect(text).toMatch(/markdown: 31\.2ms \(2\.5% of all parse time\)/);
    expect(text).toMatch(/html: 1204\.5ms \(97\.5% of all parse time\)/);
  });

  it('charges each pass against its OWN kind, never the command total', () => {
    // Dividing an HTML pass by the command's whole budget would shrink it into
    // invisibility on a markdown-dominant tree while still printing a confident
    // percentage. 60% of the html group, not 60% of everything.
    const text = render();
    expect(text).toMatch(/parse5-parse\s+8\.6ms\s+60\.0% of html/);
    expect(text).toMatch(/remark-parse\s+402\.7ms\s+43\.7% of markdown/);
  });

  it('says a corpus is mixed rather than crowning a bare majority', () => {
    // At 55/45 neither breakdown describes the tree, and calling either one
    // dominant would be the same overclaim in a quieter voice.
    const text = render({
      kinds: [
        parseKind('markdown', 500, 550, PASSES),
        parseKind('html', 400, 450, htmlPasses(400, 450)),
      ],
    });
    expect(text).toMatch(/MIXED CORPUS/);
    expect(text).toMatch(/No single kind's breakdown describes this tree/);
    expect(text).not.toMatch(/DOMINATES/);
  });

  it('says a kind did not run instead of printing its zeroes', () => {
    // One level down from the attribution states, and the same failure: four
    // rows of `0.0ms` under a heading read as "this parser is free".
    const text = render({
      kinds: [
        parseKind('markdown', DOCUMENTS, MARKDOWN_TOTAL_MS, PASSES),
        parseKind('html', 0, 0, []),
      ],
    });
    expect(text).toMatch(/html: .*this parser did not run, so there is nothing to attribute/);
    expect(text).not.toContain('parse5-parse');
  });

  it('CONTROL: one kind alone is not announced as dominating anything', () => {
    // Nothing to compare it against, so a dominance claim would be noise.
    const text = render({ kinds: [parseKind('markdown', DOCUMENTS, MARKDOWN_TOTAL_MS, PASSES)] });
    expect(text).not.toMatch(/DOMINATES|MIXED CORPUS/);
    expect(text).toContain(LEXER);
  });
});

describe('renderParseReport — the breakdown', () => {
  it('gives every pass its calls, its milliseconds, its share and its per-document cost', () => {
    const text = render();

    // 402.7 of the markdown group's 921.6 is 43.7%. The share is the point of
    // the facet: a bare millisecond figure cannot say whether a pass is worth
    // attacking.
    expect(text).toContain(LEXER);
    expect(text).toContain('402.7ms');
    expect(text).toContain('43.7% of markdown');
    // 402.7 / 1364 markdown documents.
    expect(text).toContain('0.295 ms/doc');
    expect(text).toContain('1,364 calls');
  });

  it('always prints the unattributed remainder', () => {
    const text = render();
    const remainder = MARKDOWN_TOTAL_MS - ATTRIBUTED_MS;

    // Without this line a partial instrument looks like a finished explanation.
    expect(text).toContain('unattributed');
    expect(text).toContain(remainder.toFixed(1));
  });

  it('warns when the passes sum to MORE than the bracket around them', () => {
    // Float noise is a few thousandths and stays quiet; this is a broken
    // bracketing, and printing a negative share without a word would read as a
    // rendering bug rather than as a finding about the seam.
    expect(render({ kinds: withMarkdownRemainder(-40) })).toMatch(/NEGATIVE/);
  });

  it('CONTROL: float-scale noise in the remainder is not flagged', () => {
    expect(render({ kinds: withMarkdownRemainder(-0.002) })).not.toMatch(/NEGATIVE/);
  });

  it('states the cache split as a rate over every parser kind', () => {
    const text = render({ cacheHits: 300, cacheMisses: 700 });

    expect(text).toContain('300 hits / 700 misses');
    expect(text).toContain('30.0% hit rate');
    // The label is load-bearing: documents and misses are not two names for one
    // number, in either direction, and a per-document rate would invite a reader
    // to reconcile them.
    expect(text).toMatch(/ALL parser kinds/);
    expect(text).toMatch(/not a per-document rate/);
  });

  it('names the parses that skipped the cache as a remainder, not an invariant', () => {
    const text = render({ uncachedParses: 12 });
    expect(text).toMatch(/12 never consulted the cache/);
    expect(text).toMatch(/not an invariant/);
  });

  it('flags more cache misses than parses rather than printing a negative count', () => {
    const text = render({ uncachedParses: -5 });
    expect(text).toMatch(/5 MORE cache misses than parses/);
    expect(text).toMatch(/do not reconcile/);
  });

  it('says when the repeats did not parse the same work', () => {
    expect(render({ stable: false })).toMatch(/UNSTABLE/);
    expect(render({ stable: null, runs: 1 })).toMatch(/UNTESTED/);
    expect(render()).toMatch(/repeats parsed identical work/);
  });

  it('shows every repeat total, so the spread of the reported run is visible', () => {
    // Everything else on the row comes from ONE repeat, chosen as the median.
    // Without the samples a reader cannot tell a steady run from a wild one.
    expect(render()).toContain('repeat totals 930.2ms, 936.0ms, 940.8ms');
  });
});

describe('renderParseReport — wall against CPU', () => {
  it('prints the process lifetime and labels it as NOT the parse', () => {
    const text = render();
    expect(text).toMatch(/process lifetime: 4,?200\.0ms wall/);
    expect(text).toContain('4000.0ms CPU');
    expect(text).toMatch(/the whole process, NOT the parse/);
  });

  it('says in a sentence when wall greatly exceeds CPU', () => {
    // The passes are wall-timed, so this is not a curiosity about the machine —
    // it is a caveat on every figure printed above it, and a reader must not
    // have to divide two numbers to find it.
    const text = render({ wallMs: 9000, cpuUserMs: 900, cpuSystemMs: 200 });
    expect(text).toMatch(/SPENT MOST OF ITS LIFE NOT RUNNING/);
    expect(text).toMatch(/carries that waiting inside it/);
  });

  it('CONTROL: a CPU-bound process draws no warning', () => {
    expect(render()).not.toMatch(/NOT RUNNING/);
  });
});

describe('renderParseReport — the states that all look like zero', () => {
  /** A row with the numbers a run that attributed nothing actually produces. */
  const empty = (attribution: ParseCommandStats['attribution'], over: Partial<ParseCommandStats>) =>
    render({ attribution, kinds: [], ...over });

  it('says a warm run was a warm run, and names the remedy', () => {
    const text = empty('all-cache-hits', { cacheHits: DOCUMENTS, cacheMisses: 0 });

    expect(text).toMatch(/EVERY DOCUMENT WAS A CACHE HIT/);
    expect(text).toContain('--cache cold');
    // And it does NOT print a breakdown of zeroes beside that sentence.
    expect(text).not.toContain(LEXER);
  });

  it('says a command that never parsed is NOT a warm cache', () => {
    // The two are identical in the numbers — `documents: 0` — and support
    // opposite conclusions: one means "your cache works", the other means "your
    // command did not do what you think".
    const text = empty('nothing-parsed', { cacheHits: 0, cacheMisses: 0 });

    expect(text).toMatch(/NOTHING WAS PARSED AT ALL/);
    expect(text).toMatch(/not a warm cache/);
    expect(text).not.toMatch(/CACHE HIT/);
  });

  it('says when the misses reached no parser this build knows about', () => {
    const text = empty('uninstrumented-only', { cacheHits: 0, cacheMisses: 12 });
    expect(text).toMatch(/THE CACHE MISSED BUT NO PARSER REPORTED/);
    expect(text).toContain('12 misses');
  });

  it('renders a failed row as its failure and nothing else', () => {
    const text = render({ failed: true, failure: 'REFUSED: no parse-timing dumps', kinds: [] });
    expect(text).toContain('FAILED — REFUSED: no parse-timing dumps');
    expect(text).not.toContain('unattributed');
  });
});

describe('renderParseComparison', () => {
  it('leads with the totals and lists every pass, marking only the real movers', () => {
    const moved = PASSES.map((pass) =>
      pass.pass === LEXER ? { ...pass, elapsedMs: 302.7 } : pass,
    );
    const after = parseCommand({
      kinds: [
        parseKind('markdown', DOCUMENTS, MARKDOWN_TOTAL_MS - 100, moved),
        parseKind('html', HTML_DOCUMENTS, HTML_TOTAL_MS, htmlPasses(HTML_DOCUMENTS, HTML_TOTAL_MS)),
      ],
    });
    const text = renderParseComparison(compareOneParseCommand(parseCommand(), after));

    expect(text).toContain('CHANGED');
    expect(text).toContain('total 936.0ms -> 836.0ms (-100.0ms)');
    expect(text).toContain('402.7ms -> 302.7ms');
    // Every pass appears; the unmoved ones say why they are not findings.
    for (const pass of PASSES) expect(text).toContain(pass.pass);
    expect(text).toMatch(/within noise/);
  });

  it('qualifies each moved pass with the kind it belongs to', () => {
    // Two parsers legitimately run a pass of the same name. A comparison that
    // keyed on the bare name would add two unrelated parsers' rows together and
    // report the sum as one pass's movement.
    const after = parseCommand({
      kinds: [
        parseKind('markdown', DOCUMENTS, MARKDOWN_TOTAL_MS, PASSES),
        parseKind('html', HTML_DOCUMENTS, 200, htmlPasses(HTML_DOCUMENTS, 200)),
      ],
    });
    const text = renderParseComparison(compareOneParseCommand(parseCommand(), after));

    expect(text).toContain('markdown/estimate-tokens');
    expect(text).toContain('html/estimate-tokens');
  });

  it('never renders an unmeasurable pair as agreement', () => {
    const warm = parseCommand({ attribution: 'all-cache-hits', kinds: [] });
    const text = renderParseComparison(compareOneParseCommand(warm, parseCommand()));

    expect(text).toContain('NO MEASUREMENT');
    expect(text).not.toContain('unchanged');
  });

  it('prints the caveat when the two sides parsed different corpora', () => {
    const bigger = parseCommand({
      kinds: [
        parseKind('markdown', DOCUMENTS + 200, MARKDOWN_TOTAL_MS, PASSES),
        parseKind('html', HTML_DOCUMENTS, HTML_TOTAL_MS, htmlPasses(HTML_DOCUMENTS, HTML_TOTAL_MS)),
      ],
    });
    const text = renderParseComparison(compareOneParseCommand(parseCommand(), bigger));
    expect(text).toMatch(/different numbers of documents/);
  });

  it('warns at the top when either side was captured on a busy machine', () => {
    const busy = parseReport([parseCommand()], {
      body: parseBody([parseCommand()], BUSY_LOAD),
    });
    const comparison = compareOneParseCommand(parseCommand(), parseCommand());
    expect(renderParseComparison({ ...comparison, contaminated: true })).toMatch(
      /contaminated machine/,
    );
    // The fixture really can produce the flag through the comparator, not only
    // by being spread over.
    expect(busy.body.load.contaminated).toBe(true);
  });
});
