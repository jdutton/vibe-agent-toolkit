/**
 * Shared `parse` fixtures for the comparator and renderer suites.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Extracted for the same reason `io-fixtures.ts` was: both suites need a
 * well-formed body to vary one field of, and two copies of a sixteen-field
 * command literal drift apart the moment the contract changes.
 *
 * The defaults are the shape the facet was specified against — a cold
 * `resources scan` over 1,364 markdown documents, every one a cache miss, with
 * `total` bracketing eight passes and a real unattributed remainder left over.
 * Using plausible numbers means a test that prints them reads like a report.
 */

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareParse, type ParseComparisonResult } from '../src/facets/parse/compare.js';
import {
  PARSE_FACET,
  PARSE_FACET_VERSION,
  type ParseBody,
  type ParseCommandStats,
  type ParseKindStats,
  type ParsePassStats,
} from '../src/facets/parse/types.js';
import type { LoadReadings } from '../src/harness/types.js';

import { CLEAN_LOAD, makeReport } from './report-fixtures.js';

/**
 * Pass names both parsers share.
 *
 * The same operation really does run in both pipelines, and the two report it
 * under the same name on purpose — grouping by kind is what keeps them apart, so
 * the names can stay comparable.
 */
const ESTIMATE_TOKENS = 'estimate-tokens';
const MEASURE_CONTENT = 'measure-content';

/** How many markdown documents the default fixture parses. */
export const DOCUMENTS = 1364;

/** How many HTML documents the default (markdown-dominant) fixture parses. */
export const HTML_DOCUMENTS = 22;

/**
 * The eight attributed markdown passes, summing to 904.95 against a total of
 * 921.6 — so the fixture carries a real unattributed remainder rather than a
 * tidy zero.
 */
export const PASSES: readonly ParsePassStats[] = Object.freeze([
  { pass: ESTIMATE_TOKENS, calls: DOCUMENTS, elapsedMs: 12.345 },
  { pass: 'remark-processor', calls: DOCUMENTS, elapsedMs: 88.1 },
  { pass: 'remark-parse', calls: DOCUMENTS, elapsedMs: 402.7 },
  { pass: 'ast-facts', calls: DOCUMENTS, elapsedMs: 95.2 },
  { pass: 'unresolved-references', calls: DOCUMENTS, elapsedMs: 61 },
  { pass: 'code-context-ranges', calls: DOCUMENTS, elapsedMs: 44.3 },
  { pass: 'lexical-references', calls: DOCUMENTS, elapsedMs: 130.9 },
  { pass: MEASURE_CONTENT, calls: DOCUMENTS, elapsedMs: 70.4 },
]);

/** What {@link PASSES} sums to, so a test never has to restate the arithmetic. */
export const ATTRIBUTED_MS = PASSES.reduce((sum, pass) => sum + pass.elapsedMs, 0);

/** The markdown group's bracketing total in the default fixture. */
export const MARKDOWN_TOTAL_MS = 921.6;

/** The HTML group's bracketing total in the default (markdown-dominant) fixture. */
export const HTML_TOTAL_MS = 14.4;

/** The command-wide parse budget the default fixture reports. */
export const TOTAL_MS = MARKDOWN_TOTAL_MS + HTML_TOTAL_MS;

/**
 * The four attributed HTML passes, scaled to whatever total a case wants.
 *
 * Proportional rather than fixed so an HTML-dominant fixture and a
 * markdown-dominant one share one pass shape and differ only in magnitude —
 * which is the variable the dominance rendering turns on.
 *
 * @param documents - How many documents each pass ran over
 * @param totalMs - The group's bracketing total; the passes take 90% of it
 * @returns The four passes, leaving a real unattributed remainder
 */
export function htmlPasses(documents: number, totalMs: number): readonly ParsePassStats[] {
  const shares = [
    ['parse5-parse', 0.6],
    ['element-walk', 0.2],
    [ESTIMATE_TOKENS, 0.02],
    [MEASURE_CONTENT, 0.08],
  ] as const;
  return shares.map(([pass, fraction]) => ({
    pass,
    calls: documents,
    elapsedMs: totalMs * fraction,
  }));
}

/**
 * One parser kind's block, with a real remainder.
 *
 * @param kind - The parser kind
 * @param documents - Documents it parsed
 * @param totalMs - Its bracketing total
 * @param passes - Its attributed passes
 * @returns A complete kind row
 */
export function parseKind(
  kind: string,
  documents: number,
  totalMs: number,
  passes: readonly ParsePassStats[],
): ParseKindStats {
  return {
    kind,
    documents,
    bytes: documents * 5957,
    passes,
    totalCalls: documents,
    totalMs,
    unattributedMs: totalMs - passes.reduce((sum, pass) => sum + pass.elapsedMs, 0),
  };
}

/** The default fixture's HTML group, which most cases hold still. */
export function defaultHtmlKind(): ParseKindStats {
  return parseKind('html', HTML_DOCUMENTS, HTML_TOTAL_MS, htmlPasses(HTML_DOCUMENTS, HTML_TOTAL_MS));
}

/** The default fixture's kinds: a markdown-dominant corpus with a little HTML. */
export const KINDS: readonly ParseKindStats[] = Object.freeze([
  parseKind('markdown', DOCUMENTS, MARKDOWN_TOTAL_MS, PASSES),
  defaultHtmlKind(),
]);

/**
 * The default corpus with the MARKDOWN group varied and the HTML group held.
 *
 * The overrides are applied last and unchecked, so a case can publish a
 * deliberately inconsistent group — a remainder that does not follow from the
 * passes, say — which is how a test proves the comparator reads what was
 * published rather than recomputing it.
 *
 * @param over - What the case varies about the markdown group
 * @returns Both kinds
 */
export function withMarkdown(over: Partial<ParseKindStats> = {}): readonly ParseKindStats[] {
  const base = parseKind(
    'markdown',
    over.documents ?? DOCUMENTS,
    over.totalMs ?? MARKDOWN_TOTAL_MS,
    over.passes ?? PASSES,
  );
  return [{ ...base, ...over }, defaultHtmlKind()];
}

/**
 * Every aggregate a command row carries, summed over its kinds.
 *
 * Derived rather than restated so a fixture can vary the kinds without leaving
 * the totals describing a different run than the breakdown does.
 *
 * @param kinds - The command's kinds
 * @returns The command-wide aggregates
 */
function aggregate(kinds: readonly ParseKindStats[]): {
  documents: number;
  bytes: number;
  totalCalls: number;
  totalMs: number;
  unattributedMs: number;
} {
  const sum = (pick: (kind: ParseKindStats) => number): number =>
    kinds.reduce((running, kind) => running + pick(kind), 0);
  return {
    documents: sum((kind) => kind.documents),
    bytes: sum((kind) => kind.bytes),
    totalCalls: sum((kind) => kind.totalCalls),
    totalMs: sum((kind) => kind.totalMs),
    unattributedMs: sum((kind) => kind.unattributedMs),
  };
}

/**
 * One measured command, defaulting to a clean, stable, cold run.
 *
 * The aggregates follow whatever `kinds` the caller supplies, so a case that
 * varies the corpus never has to keep two sets of numbers in step by hand.
 *
 * @param over - Fields to replace
 * @returns A complete command row
 */
export function parseCommand(over: Partial<ParseCommandStats> = {}): ParseCommandStats {
  const kinds = over.kinds ?? KINDS;
  const totals = aggregate(kinds);
  return {
    name: 'resources-scan',
    args: ['resources', 'scan', 'docs/'],
    cache: 'cold',
    runs: 3,
    stable: true,
    attribution: 'measured',
    processes: 2,
    kinds,
    ...totals,
    cacheHits: 0,
    cacheMisses: totals.documents,
    uncachedParses: 0,
    totalMsSamples: [930.2, totals.totalMs, 940.8],
    wallMs: 4200,
    cpuUserMs: 3600,
    cpuSystemMs: 400,
    failed: false,
    failure: null,
    ...over,
  };
}

/** An HTML-dominant corpus: the shape a markdown-only instrument was blind to. */
export const HTML_DOMINANT_KINDS: readonly ParseKindStats[] = Object.freeze([
  parseKind('markdown', 40, 31.2, [
    { pass: ESTIMATE_TOKENS, calls: 40, elapsedMs: 0.4 },
    { pass: 'remark-processor', calls: 40, elapsedMs: 2.6 },
    { pass: 'remark-parse', calls: 40, elapsedMs: 14.1 },
    { pass: 'ast-facts', calls: 40, elapsedMs: 3.3 },
    { pass: 'unresolved-references', calls: 40, elapsedMs: 2.1 },
    { pass: 'code-context-ranges', calls: 40, elapsedMs: 1.5 },
    { pass: 'lexical-references', calls: 40, elapsedMs: 4.6 },
    { pass: MEASURE_CONTENT, calls: 40, elapsedMs: 2.1 },
  ]),
  parseKind('html', 1830, 1204.5, htmlPasses(1830, 1204.5)),
]);

/**
 * A body around the given rows.
 *
 * @param commands - The measured commands
 * @param load - Machine load, defaulting to a quiet machine
 * @returns A complete `parse` body
 */
export function parseBody(
  commands: readonly ParseCommandStats[],
  load: LoadReadings = CLEAN_LOAD,
): ParseBody {
  return { commands, load };
}

/**
 * A `parse` envelope wrapping the given rows.
 *
 * Built through `makeReport` so the coordinate and the format version stay in
 * one place; only the facet header and the body are overridden here.
 *
 * @param commands - The measured commands
 * @param over - Envelope fields the case varies
 * @returns A complete `parse` report
 */
export function parseReport(
  commands: readonly ParseCommandStats[],
  over: Partial<ReportEnvelope<unknown>> = {},
): ReportEnvelope<ParseBody> {
  return makeReport({
    facet: PARSE_FACET,
    facetVersion: PARSE_FACET_VERSION,
    body: parseBody(commands),
    ...over,
  }) as ReportEnvelope<ParseBody>;
}

/**
 * Compare two one-command reports at the shared baseline coordinate.
 *
 * Both suites need this — the comparator suite to read verdicts off it, the
 * renderer suite to feed a real comparison into the renderer rather than a
 * hand-built literal that could drift from what `compareParse` actually emits.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The comparison, which never refuses at a shared coordinate
 * @throws When the comparison refused, which no caller of this helper expects
 */
export function compareOneParseCommand(
  before: ParseCommandStats,
  after: ParseCommandStats,
): ParseComparisonResult {
  const result = compareParse(parseReport([before]), parseReport([after]));
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
  return result;
}
